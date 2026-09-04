"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Sphere, Line, Text, Html } from "@react-three/drei";
import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import { Vector3, MathUtils, Raycaster, Intersection } from "three";
import type { GraphData, GraphNode } from "@/components/statistics/types";
import { Badge } from "@/components/ui/badge";

/**
 * 3D Globe Knowledge Graph
 *
 * Nodes are positioned on a sphere surface using a spiral layout.
 * Edges are drawn as curved lines connecting nodes.
 * Auto‑rotation with smooth easing, orbit controls for user interaction.
 * Nodes are clickable – selection highlights and triggers side panel update.
 * No rubber‑band effect: nodes are fixed on the sphere.
 */

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
}: {
  node: GraphNode;
  position: Vector3;
  isSelected: boolean;
  isHovered: boolean;
  onClick: () => void;
  onHover: (hovered: boolean) => void;
  radius: number;
}) {
  const meshRef = useRef<any>(null);
  const color = node.type === "semantic" ? "#0ea5e9" : "#a855f7"; // teal/blue, purple

  useFrame(() => {
    if (meshRef.current) {
      // Subtle pulse animation
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

// --- Component: edge line (curved) ---
function EdgeLine({
  start,
  end,
  sourceNode,
  targetNode,
  strength,
  type,
}: {
  start: Vector3;
  end: Vector3;
  sourceNode: GraphNode;
  targetNode: GraphNode;
  strength: number;
  type: string;
}) {
  // Compute radii for nodes
  const sourceRadius = 0.2 + 0.08 * Math.min(1, sourceNode.degree / 5);
  const targetRadius = 0.2 + 0.08 * Math.min(1, targetNode.degree / 5);

  // Direction from start to end
  const direction = new Vector3().copy(end).sub(start).normalize();
  const startOffset = new Vector3().copy(start).add(direction.clone().multiplyScalar(sourceRadius));
  const endOffset = new Vector3().copy(end).sub(direction.clone().multiplyScalar(targetRadius));

  const midpoint = useMemo(() => {
    const mid = new Vector3().addVectors(start, end).multiplyScalar(0.5);
    const distance = start.distanceTo(end);
    const offset = 0.2 + strength * 0.6;
    mid.add(new Vector3(0, distance * offset, 0));
    return mid;
  }, [start, end, strength]);

  const curve = useMemo(() => {
    const points = [];
    // Quadratic bezier: B(t) = (1-t)^2 * P0 + 2*(1-t)*t * P1 + t^2 * P2
    for (let t = 0; t <= 1; t += 0.05) {
      const t1 = 1 - t;
      const x = t1 * t1 * startOffset.x + 2 * t1 * t * midpoint.x + t * t * endOffset.x;
      const y = t1 * t1 * startOffset.y + 2 * t1 * t * midpoint.y + t * t * endOffset.y;
      const z = t1 * t1 * startOffset.z + 2 * t1 * t * midpoint.z + t * t * endOffset.z;
      points.push(new Vector3(x, y, z));
    }
    return points;
  }, [startOffset, endOffset, midpoint]);

  const color = type === "consolidated_into" ? "#f59e0b" : "#8b5cf6"; // amber, violet

  return (
    <Line
      points={curve}
      color={color}
      transparent
      opacity={0.4 + strength * 0.4}
      lineWidth={1}
      dashed={type === "consolidated_into"}
    />
  );
}

// --- Inner scene component that uses useThree hook ---
function GlobeScene({
  graph,
  selectedNodeId,
  onSelectNode,
}: {
  graph: GraphData;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const { camera } = useThree();

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

  // Map node IDs to node objects
  const nodeMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    graph.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [graph.nodes]);

  // Auto-rotation state
  const rotationRef = useRef(0);
  const isDragging = useRef(false);

  useFrame((state, delta) => {
    if (!isDragging.current) {
      rotationRef.current += delta * 0.08;
      camera.position.x = 6 * Math.sin(rotationRef.current);
      camera.position.z = 6 * Math.cos(rotationRef.current);
      camera.lookAt(0, 0, 0);
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
        <meshBasicMaterial color="#1e293b" transparent opacity={0.1} wireframe />
      </Sphere>
      <Sphere args={[4.9, 32, 32]}>
        <meshBasicMaterial color="#0ea5e9" transparent opacity={0.03} wireframe />
      </Sphere>

      {/* Edges */}
      {graph.edges.map((edge) => {
        const start = positions.get(edge.source);
        const end = positions.get(edge.target);
        const sourceNode = nodeMap.get(edge.source);
        const targetNode = nodeMap.get(edge.target);
        if (!start || !end || !sourceNode || !targetNode) return null;
        return (
          <EdgeLine
            key={`${edge.source}-${edge.target}`}
            start={start}
            end={end}
            sourceNode={sourceNode}
            targetNode={targetNode}
            strength={edge.strength}
            type={edge.relationType}
          />
        );
      })}

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

  return (
    <div ref={containerRef} className="w-full h-full min-h-[500px] relative">
      <Canvas
        camera={{ position: [0, 0, 6], fov: 45 }}
        style={{ background: "transparent" }}
      >
        <GlobeScene
          graph={graph}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
        />
      </Canvas>
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-muted-foreground opacity-60">
        Drag to rotate · Scroll to zoom
      </div>
    </div>
  );
}