"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Sphere, Html } from "@react-three/drei";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import { Vector3 } from "three";
import type { GraphData, GraphNode } from "@/components/statistics/types";

// Replace deprecated THREE.Clock with THREE.Timer adapter so internal fiber
// state creation uses THREE.Timer without throwing console deprecation warnings.
if (typeof window !== "undefined" && (THREE as unknown as { Timer?: typeof THREE.Timer }).Timer) {
  const TimerClass = THREE.Timer;

  class TimerClock {
    autoStart: boolean;
    startTime = 0;
    oldTime = 0;
    elapsedTime = 0;
    running = false;
    private _timer: InstanceType<typeof TimerClass>;

    constructor(autoStart = true) {
      this.autoStart = autoStart;
      this._timer = new TimerClass();
      if (autoStart) {
        this.start();
      }
    }

    start() {
      this.startTime = performance.now();
      this.oldTime = this.startTime;
      this.elapsedTime = 0;
      this.running = true;
      this._timer.reset();
    }

    stop() {
      this.getElapsedTime();
      this.running = false;
      this.autoStart = false;
    }

    getElapsedTime() {
      this.getDelta();
      return this.elapsedTime;
    }

    getDelta() {
      let diff = 0;
      if (this.autoStart && !this.running) {
        this.start();
        return 0;
      }
      if (this.running) {
        this._timer.update();
        diff = this._timer.getDelta();
        this.oldTime = performance.now();
        this.elapsedTime += diff;
      }
      return diff;
    }
  }

  try {
    Object.defineProperty(THREE, "Clock", {
      value: TimerClock,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (err) {
    console.debug(`[KnowledgeGraphGlobe] Error: ${err instanceof Error ? err.message : String(err)}`);
    // Ignore if property is non-configurable in some bundles
  }
}

/**
 * 3D Globe Knowledge Graph
 *
 * Nodes are positioned on a sphere surface using a spiral layout.
 * Edges are drawn as curved lines connecting nodes.
 * Auto‑rotation with smooth easing, orbit controls for user interaction.
 * Nodes are clickable - selection highlights and triggers side panel update.
 * No rubber‑band effect: nodes are fixed on the sphere.
 */

/** Detects prefers-reduced-motion media query to disable WebGL render loop rotations. */
function subscribeReducedMotion(callback: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

function getReducedMotionSnapshot() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false);
}

/** Resolves CSS variables to computed RGB values that Three.js materials accept. */
function getCssToken(variable: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!raw) return fallback;
  try {
    const el = document.createElement("span");
    el.style.color = raw;
    document.documentElement.appendChild(el);
    const computed = getComputedStyle(el).color;
    document.documentElement.removeChild(el);
    if (/^rgb\(/i.test(computed) || /^rgba\(/i.test(computed)) {
      return computed;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// --- Layout: place nodes on a sphere using Fibonacci sphere algorithm ---
function fibonacciSphere(samples: number, radius: number): Vector3[] {
  const points: Vector3[] = [];
  const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle
  for (let i = 0; i < samples; i++) {
    const y = 1 - (i / (samples - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    points.push(new Vector3(x * radius, y * radius, z * radius));
  }
  return points;
}

// --- Component: node as a glowing sphere ---
function NodeSphere({
  node,
  position,
  isSelected,
  isHovered,
  onClick,
  onHover,
  radius,
  prefersReducedMotion,
  chart1,
  chart2,
}: {
  node: GraphNode;
  position: Vector3;
  isSelected: boolean;
  isHovered: boolean;
  onClick: () => void;
  onHover: (hovered: boolean) => void;
  radius: number;
  prefersReducedMotion: boolean;
  chart1: string;
  chart2: string;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const color = node.type === "semantic" ? chart1 : chart2;

  useFrame(() => {
    if (meshRef.current && !prefersReducedMotion) {
      // Subtle pulse animation (skipped when prefers-reduced-motion is active)
      const pulse = 1 + 0.05 * Math.sin(Date.now() * 0.002 + node.id.length);
      meshRef.current.scale.set(pulse, pulse, pulse);
    }
  });

  return (
    <group
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={() => onHover(true)}
      onPointerOut={() => onHover(false)}
    >
      <mesh ref={meshRef}>
        <sphereGeometry args={[radius, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={isSelected ? 0.8 : isHovered ? 0.4 : 0.1}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>
      {/* Glow aura */}
      <mesh scale={1.8}>
        <sphereGeometry args={[radius, 8, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} />
      </mesh>
      {isHovered && (
        <Html position={[0, radius * 2.2, 0]} center>
          <div className="pointer-events-none rounded bg-background/80 px-2 py-0.5 text-xs font-medium shadow-md backdrop-blur-sm">
            {node.label}
          </div>
        </Html>
      )}
    </group>
  );
}

// --- Edge line component removed for performance (3D view is node-only) ---

// --- Inner scene component that uses useThree hook ---
function GlobeScene({
  graph,
  selectedNodeId,
  onSelectNode,
  prefersReducedMotion,
}: {
  graph: GraphData;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  prefersReducedMotion: boolean;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const chart1 = useMemo(() => getCssToken("--chart-1", "#0ea5e9"), []);
  const chart2 = useMemo(() => getCssToken("--chart-2", "#a855f7"), []);
  const chart3 = useMemo(() => getCssToken("--chart-3", "#1e293b"), []);

  // Position nodes on sphere
  const positions = useMemo(() => {
    const radius = 4.5;
    const nodes = graph.nodes;
    const vecs = fibonacciSphere(nodes.length, radius);
    const map = new Map<string, Vector3>();
    nodes.forEach((node, i) => {
      map.set(node.id, vecs[i % vecs.length]);
    });
    return map;
  }, [graph.nodes]);

  // Auto-rotation state
  const rotationRef = useRef(0);
  const isDragging = useRef(false);

  useFrame((state, delta) => {
    if (!isDragging.current && !prefersReducedMotion) {
      rotationRef.current += delta * 0.08;
      state.camera.position.x = 6 * Math.sin(rotationRef.current);
      state.camera.position.z = 6 * Math.cos(rotationRef.current);
      state.camera.lookAt(0, 0, 0);
    }
  });

  const handleNodeClick = (nodeId: string) => {
    onSelectNode(selectedNodeId === nodeId ? null : nodeId);
  };

  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} intensity={1} />
      <pointLight position={[-10, -10, -10]} intensity={0.5} />

      {/* Outer glow sphere */}
      <Sphere args={[4.8, 48, 48]}>
        <meshBasicMaterial color={chart3} transparent opacity={0.1} wireframe />
      </Sphere>
      <Sphere args={[4.9, 32, 32]}>
        <meshBasicMaterial color={chart1} transparent opacity={0.03} wireframe />
      </Sphere>

      {/* No edges in 3D view — only nodes for a clean globe */}

      {/* Nodes */}
      {graph.nodes.map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const isSelected = selectedNodeId === node.id;
        const isHovered = hoveredId === node.id;
        const radius = 0.2 + 0.08 * Math.min(1, node.degree / 5);
        return (
          <NodeSphere
            key={node.id}
            node={node}
            position={pos}
            isSelected={isSelected}
            isHovered={isHovered}
            onClick={() => handleNodeClick(node.id)}
            onHover={(h) => setHoveredId(h ? node.id : null)}
            radius={radius}
            prefersReducedMotion={prefersReducedMotion}
            chart1={chart1}
            chart2={chart2}
          />
        );
      })}

      <OrbitControls
        enableZoom={true}
        enablePan={false}
        enableRotate={true}
        autoRotate={false}
        minDistance={3}
        maxDistance={12}
        onStart={() => { isDragging.current = true; }}
        onEnd={() => { isDragging.current = false; }}
      />
    </>
  );
}

// --- Main Globe component ---
export function KnowledgeGraphGlobe({
  graph,
  selectedNodeId,
  onSelectNode,
}: {
  graph: GraphData;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`3D knowledge graph globe with ${graph.nodes.length} memory nodes`}
      className="w-full h-full relative"
    >
      <Canvas
        camera={{ position: [0, 0, 6], fov: 45 }}
        style={{ background: "transparent" }}
      >
        <GlobeScene
          graph={graph}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          prefersReducedMotion={prefersReducedMotion}
        />
      </Canvas>
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-muted-foreground opacity-60 pointer-events-none">
        Drag to rotate · Scroll to zoom
      </div>
      {/* Keyboard accessible node selection alternative */}
      <div
        className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:top-2 focus-within:left-2 focus-within:z-10 focus-within:max-h-48 focus-within:w-56 focus-within:overflow-y-auto focus-within:rounded-md focus-within:border focus-within:bg-popover focus-within:p-2 focus-within:shadow-md"
        aria-label="Keyboard node selector"
      >
        <p className="text-[11px] font-medium text-muted-foreground mb-1">Select node:</p>
        <div className="flex flex-col gap-1">
          {graph.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              aria-pressed={selectedNodeId === node.id}
              className={`text-left text-[11px] px-2 py-1 rounded truncate focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                selectedNodeId === node.id
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-foreground"
              }`}
              onClick={() => onSelectNode(selectedNodeId === node.id ? null : node.id)}
            >
              {node.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}