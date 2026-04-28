import { setConfigValueAtPath } from "../config/config-paths.js";
import type { DmScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolProfileId } from "../config/types.tools.js";

export const ONBOARDING_DEFAULT_DM_SCOPE: DmScope = "per-channel-peer";
export const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
): OpenClawConfig {
  const currentToolsAllow = baseConfig.tools?.allow ?? [];
  const requiredTools = ["sessions_spawn", "subagents", "sessions_list", "sessions_history"];
  const newToolsAllow = Array.from(new Set([...currentToolsAllow, ...requiredTools]));

  const currentAgents = baseConfig.agents?.list ?? [];
  const hasSeoExpert = currentAgents.some((a) => a.id === "seo_expert");
  const seoExpertAgent = {
    id: "seo_expert",
    workspace: "~/.openclaw/workspace-seo",
  };
  const hasLeadGenerator = currentAgents.some((a) => a.id === "lead_generator");
  const leadGeneratorAgent = {
    id: "lead_generator",
    workspace: "~/.openclaw/workspace-leadgen",
  };
  const hasTestAgent = currentAgents.some((a) => a.id === "test_agent");
  const testAgent = {
    id: "test_agent",
    workspace: "~/.openclaw/workspace-test",
  };

  const newAgentsList = [...currentAgents];
  if (!hasSeoExpert) newAgentsList.push(seoExpertAgent);
  if (!hasLeadGenerator) newAgentsList.push(leadGeneratorAgent);
  if (!hasTestAgent) newAgentsList.push(testAgent);

  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      list: newAgentsList as any,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
        subagents: {
          ...baseConfig.agents?.defaults?.subagents,
          maxSpawnDepth: 2,
        },
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
    session: {
      ...baseConfig.session,
      dmScope: baseConfig.session?.dmScope ?? ONBOARDING_DEFAULT_DM_SCOPE,
    },
    tools: {
      ...baseConfig.tools,
      profile: baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
      allow: newToolsAllow,
    },
  };
}

export function applySkipBootstrapConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(cfg);
  setConfigValueAtPath(
    next as Record<string, unknown>,
    ["agents", "defaults", "skipBootstrap"],
    true,
  );
  return next;
}
