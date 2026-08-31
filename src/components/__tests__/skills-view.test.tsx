import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillsView } from "../skills-view";

// vitest runs without globals:true, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

const mockSkills = [
  {
    id: "skill-one",
    name: "weekly-report",
    description: "Generates a weekly status report from chat history.",
    version: "1.2.0",
    enabled: true,
    pluginId: null,
    source: { kind: "local" },
  },
  {
    id: "skill-two",
    name: "code-review",
    description: "Reviews a diff against repo standards.",
    version: null,
    enabled: false,
    pluginId: "plugin-a",
    source: { kind: "plugin", plugin: "devtools" },
  },
];

const mockCatalogPage1 = {
  registry: "clawhub",
  items: [
    {
      slug: "pdf-tools",
      displayName: "PDF Tools",
      summary: "Merge and split PDF files.",
      ownerHandle: "alice",
      downloads: 1200,
    },
    {
      slug: "web-scraper",
      displayName: "Web Scraper",
      summary: "Scrape pages into markdown.",
      ownerHandle: "bob",
      downloads: 300,
    },
  ],
  nextCursor: "cursor-2",
};

const mockCatalogPage2 = {
  registry: "clawhub",
  items: [
    {
      slug: "xlsx-wizard",
      displayName: "XLSX Wizard",
      summary: "Spreadsheet wrangling.",
      ownerHandle: "carol",
      downloads: 90,
    },
  ],
  nextCursor: null,
};

// Base fetch implementation; individual tests override specific URLs.
const fetchMock = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
  const url = String(input);
  if (url === "/api/skills") {
    return new Response(JSON.stringify({ skills: mockSkills }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith("/api/skills/search?registry=clawhub&browse=1")) {
    if (url.includes("cursor=cursor-2")) {
      return new Response(JSON.stringify(mockCatalogPage2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(mockCatalogPage1), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith("/api/skills/search?registry=skillssh")) {
    return new Response(
      JSON.stringify({
        registry: "skillssh",
        results: [
          {
            id: "vercel-labs/skills/fetch",
            skillId: "fetch",
            name: "Fetch Skill",
            installs: 42,
            source: "vercel-labs/skills",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.startsWith("/api/skills/search?registry=github")) {
    return new Response(
      JSON.stringify({
        registry: "github",
        repo: "anthropics/skills",
        ref: "HEAD",
        skills: [{ name: "skill-creator", dirPath: "skills/skill-creator" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url === "/api/skills/install" && opts?.method === "POST") {
    return new Response(
      JSON.stringify({
        skill: { id: "skill-new", name: "pdf-tools", enabled: true },
        replaced: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.startsWith("/api/skills/skill-one") && opts?.method === "PATCH") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
});

describe("SkillsView", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  it("shows the manage tab by default with installed skills", async () => {
    render(<SkillsView onBack={() => {}} />);

    // Manage tab is active by default and lists installed skills.
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();

    // Both tabs are present.
    expect(screen.getByRole("tab", { name: "Manage skills" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Skill marketplace" })
    ).toBeInTheDocument();

    // The marketplace content is not visible on the manage tab.
    expect(screen.queryByText("PDF Tools")).not.toBeInTheDocument();
  });

  it("marks plugin-owned skills and shows the source label", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();

    // plugin badge for the plugin-installed row.
    expect(screen.getByText("plugin")).toBeInTheDocument();
    // Source labels.
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("Plugin · devtools")).toBeInTheDocument();
  });

  it("filters the installed list by name", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter installed skills"), {
      target: { value: "weekly" },
    });
    expect(screen.getByText("weekly-report")).toBeInTheDocument();
    expect(screen.queryByText("code-review")).not.toBeInTheDocument();
  });

  it("switches to the marketplace tab and browses ClawHub by default", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Skill marketplace" }));

    // Browse-first: the recommended catalog loads without a query.
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    expect(screen.getByText("Web Scraper")).toBeInTheDocument();
    // Install counts shown.
    expect(screen.getByText("1,200 installs")).toBeInTheDocument();
    // Load-more appears because the page reports a next cursor.
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("loads the next catalog page on Load more", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Skill marketplace" }));
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("XLSX Wizard")).toBeInTheDocument();
    // First-page rows stay mounted.
    expect(screen.getByText("PDF Tools")).toBeInTheDocument();
  });

  it("searches skills.sh after switching registries", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Skill marketplace" }));
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "skills.sh" }));
    // ClawHub browse content cleared after switching registries.
    await waitFor(() => {
      expect(screen.queryByText("PDF Tools")).not.toBeInTheDocument();
    });

    const input = screen.getByLabelText("Search skills.sh skills");
    await userEvent.type(input, "fetch");
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByText("Fetch Skill")).toBeInTheDocument();
    expect(screen.getByText("vercel-labs/skills")).toBeInTheDocument();
  });

  it("lists GitHub repo skills from the github registry", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Skill marketplace" }));
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "GitHub repo" }));
    const input = screen.getByLabelText("GitHub repository");
    await userEvent.type(input, "anthropics/skills");
    await userEvent.click(screen.getByRole("button", { name: "List skills" }));

    // The repo row (not the skill-creator hint link) is rendered with
    // its dirPath summary.
    expect(await screen.findByText("skills/skill-creator")).toBeInTheDocument();
    const rows = screen.getAllByText("skill-creator");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("installs a marketplace skill and shows a notice", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Skill marketplace" }));
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    // One Install button per catalog row; click the first.
    const installButtons = screen.getAllByRole("button", { name: "Install" });
    expect(installButtons.length).toBeGreaterThan(0);
    await userEvent.click(installButtons[0]);

    expect(
      await screen.findByText(/Installed skill “pdf-tools”/i)
    ).toBeInTheDocument();
  });

  it("toggles an installed skill's enabled state", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();

    const toggle = screen.getByRole("switch", { name: "Toggle weekly-report" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Toggle weekly-report" })
      ).not.toBeChecked();
    });
    const patch = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes("/api/skills/skill-one") && call[1]?.method === "PATCH"
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ enabled: false });
  });

  it("disables delete for plugin-owned skills", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();

    expect(screen.getByLabelText("Delete code-review")).toBeDisabled();
    expect(screen.getByLabelText("Delete weekly-report")).not.toBeDisabled();
  });

  it("opens the file viewer for an installed skill", async () => {
    render(<SkillsView onBack={() => {}} />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("View weekly-report files"));

    // Dialog opens and fetches the file list.
    expect(await screen.findByText("Select a file to preview its content.")).toBeInTheDocument();
    const filesCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/skills/skill-one/files")
    );
    expect(filesCall).toBeDefined();
  });

  it("shows the empty state with a marketplace shortcut when nothing is installed", async () => {
    fetchMock.mockImplementationOnce(async () => {
      // First call (/api/skills) returns an empty list this test only.
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    // Subsequent /api/skills calls (post-install refresh) fall through.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/skills") {
        return new Response(JSON.stringify({ skills: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/skills/search?registry=clawhub&browse=1")) {
        return new Response(JSON.stringify(mockCatalogPage1), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    render(<SkillsView onBack={() => {}} />);
    expect(
      await screen.findByText("No skills installed yet")
    ).toBeInTheDocument();

    // The shortcut jumps straight to the marketplace tab.
    await userEvent.click(screen.getByRole("button", { name: /Open marketplace/i }));
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
  });
});
