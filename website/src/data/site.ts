// SPDX-License-Identifier: Apache-2.0

export const SITE = {
  name: "Comis",
  url: "https://comis.ai",
  title: "Comis: Security-first runtime for AI agents",
  description:
    "Open-source, self-hosted runtime for bounded agent action and governed learning across sessions, with runtime-enforced authority and recorded evidence.",
  positioning: "Open-source runtime for bounded action and governed learning.",
  status: "Open source / Self-hosted / Active development",
  reviewCommand: "curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh",
  installCommand: "curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash",
  npm: "https://www.npmjs.com/package/comisai",
  docs: "https://docs.comis.ai",
  installationDocs: "https://docs.comis.ai/installation",
  knownLimitations: "https://docs.comis.ai/reference/known-limitations",
  securityDocs: "https://docs.comis.ai/security",
  githubOrganization: "https://github.com/comisai",
  github: "https://github.com/comisai/comis",
  issues: "https://github.com/comisai/comis/issues",
  discussions: "https://github.com/comisai/comis/discussions",
  contributing: "https://github.com/comisai/comis/blob/main/CONTRIBUTING.md",
  security: "https://github.com/comisai/comis/security",
  threatModel: "https://github.com/comisai/comis/blob/main/THREAT_MODEL.md",
  learningCatalog:
    "https://github.com/comisai/comis/blob/main/test/live/self-driving/targets/MEMORY-LEARNING-STRESS-CATALOG.md",
  license: "https://github.com/comisai/comis/blob/main/LICENSE",
} as const;
