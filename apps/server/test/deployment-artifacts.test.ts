// Phase 10 is a documentation and deployment phase, so its acceptance criteria are
// about the files that ship with the system. These tests guard the promises those
// documents make: every environment variable the config reads is documented, no
// real secret is committed, .env stays ignored, the documented commands exist, the
// deployment scripts are present, and the user manual covers all five roles.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readRepositoryFile(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function fileExists(relativePath: string): boolean {
  try {
    readFileSync(path.join(repositoryRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

/** The environment variable names the server config schema declares. */
function configVariableNames(): string[] {
  const configSource = readRepositoryFile("apps/server/src/config.ts");
  const matches = configSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*z\./gm);
  return [...matches].map((match) => match[1]).filter((name): name is string => name !== undefined);
}

describe("environment documentation", () => {
  it("documents every variable the config module validates", () => {
    const documented = readRepositoryFile(".env.example");

    const missing = configVariableNames().filter(
      (variableName) => !documented.includes(`${variableName}=`)
    );

    expect(missing).toEqual([]);
  });

  it("lists at least the core variables, so the extractor cannot silently return nothing", () => {
    const variableNames = configVariableNames();

    expect(variableNames).toContain("DATABASE_URL");
    expect(variableNames).toContain("JWT_SECRET");
    expect(variableNames).toContain("CORS_ORIGIN");
  });

  it("contains no real secret in the committed example", () => {
    const example = readRepositoryFile(".env.example");

    expect(example).toContain("DATABASE_URL=postgresql://bcis_user:change_this@");
    expect(example).toContain("JWT_SECRET=change_this_to_a_long_random_string");
  });

  it("ignores .env but keeps .env.example tracked", () => {
    const gitignoreLines = readRepositoryFile(".gitignore").split("\n");

    expect(gitignoreLines).toContain(".env");
    expect(gitignoreLines).toContain("!.env.example");
  });
});

describe("documented commands exist", () => {
  it("has every root script the README and deployment guide promise", () => {
    const rootPackage = JSON.parse(readRepositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const scripts = rootPackage.scripts ?? {};

    for (const scriptName of [
      "dev",
      "start",
      "build",
      "build:installer",
      "typecheck",
      "lint",
      "test",
      "db:generate",
      "db:migrate",
      "db:seed",
      "backup",
      "restore",
      "submission",
    ]) {
      expect(scripts, `root script "${scriptName}"`).toHaveProperty(scriptName);
    }
  });

  it("has a server script that seeds the database", () => {
    const serverPackage = JSON.parse(readRepositoryFile("apps/server/package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(serverPackage.scripts).toHaveProperty("db:seed");
  });

  it("has a client script that builds the Windows installer", () => {
    const clientPackage = JSON.parse(readRepositoryFile("apps/client/package.json")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(clientPackage.scripts).toHaveProperty("package:win");
    expect(clientPackage.devDependencies).toHaveProperty("electron-builder");
  });
});

describe("deployment artifacts", () => {
  it("ships the backup and restore scripts, wired to pnpm", () => {
    expect(readRepositoryFile("scripts/backup.sh")).toContain("pg_dump");
    expect(readRepositoryFile("scripts/restore.sh")).toContain("pg_restore");

    const rootPackage = JSON.parse(readRepositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(rootPackage.scripts?.backup).toBe("bash scripts/backup.sh");
    expect(rootPackage.scripts?.restore).toBe("bash scripts/restore.sh");
  });

  it("ships an electron-builder config that matches the real build output layout", () => {
    const builderConfig = readRepositoryFile("apps/client/electron-builder.config.js");

    // electron-vite compiles into out/, not dist/ — the config must look where the
    // build actually writes.
    expect(builderConfig).toContain("out/**/*");
    expect(builderConfig).not.toContain("dist/**/*");
    expect(builderConfig).toContain("nsis");
  });

  it("ships a client config template whose path the deployment guide documents", () => {
    const deploymentGuide = readRepositoryFile("docs/deployment/README.md");
    const clientConfigTemplate = JSON.parse(
      readRepositoryFile("apps/client/config.example.json")
    ) as { apiBaseUrl?: string };

    expect(deploymentGuide).toContain("AppData\\Roaming\\BCIS\\config.json");
    expect(clientConfigTemplate.apiBaseUrl).toMatch(/^http:\/\//);
  });
});

describe("documentation coverage", () => {
  it("ships every document the spec requires", () => {
    for (const documentPath of [
      "README.md",
      "docs/technical/README.md",
      "docs/user-manual/README.md",
      "docs/deployment/README.md",
      "docs/deployment/backup-restore.md",
      "docs/known-limitations.md",
    ]) {
      expect(fileExists(documentPath), documentPath).toBe(true);
    }
  });

  it("covers all five roles in the user manual", () => {
    const userManual = readRepositoryFile("docs/user-manual/README.md");

    for (const roleName of [
      "Administrator",
      "Billing Clerk",
      "Cashier",
      "Collector",
      "Manager",
    ]) {
      expect(userManual, roleName).toContain(roleName);
    }
  });

  it("covers the required technical sections", () => {
    const technicalDocumentation = readRepositoryFile("docs/technical/README.md");

    for (const sectionName of [
      "System Overview",
      "Project Structure",
      "Database Schema",
      "Key Design Decisions",
      "Authentication & Authorization",
      "Financial Model",
      "Collection Workflow",
      "Configuration",
      "Running in Development",
      "Running Tests",
    ]) {
      expect(technicalDocumentation, sectionName).toContain(sectionName);
    }
  });

  it("states its limitations honestly instead of claiming production completeness", () => {
    const knownLimitations = readRepositoryFile("docs/known-limitations.md");

    expect(knownLimitations.toLowerCase()).toContain("not");
    expect(knownLimitations).toContain("Electron");
    expect(knownLimitations).toContain("installer");
  });
});