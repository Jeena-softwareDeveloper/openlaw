import { normalizeProviderId } from "../agents/provider-id.js";
import { formatCliCommand } from "../cli/command-format.js";
import { commitConfigWriteWithPendingPluginInstalls } from "../cli/plugins-install-record-commit.js";
import type {
  AuthChoice,
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import { createConfigIO, replaceConfigFile, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice,
} from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import { detectSetupMigrationSources, runSetupMigrationImport } from "./setup.migration-import.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import {
  SECURITY_CONFIRM_MESSAGE,
  SECURITY_NOTE_MESSAGE,
  SECURITY_NOTE_TITLE,
} from "./setup.security-note.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./setup.types.js";

type SetupFlowChoice = WizardFlow | "import";

type AuthChoiceModule = typeof import("../commands/auth-choice.js");
type ConfigLoggingModule = typeof import("../config/logging.js");
type ModelPickerModule = typeof import("../commands/model-picker.js");

let authChoiceModulePromise: Promise<AuthChoiceModule> | undefined;
let configLoggingModulePromise: Promise<ConfigLoggingModule> | undefined;
let modelPickerModulePromise: Promise<ModelPickerModule> | undefined;

function loadAuthChoiceModule(): Promise<AuthChoiceModule> {
  authChoiceModulePromise ??= import("../commands/auth-choice.js");
  return authChoiceModulePromise;
}

function loadConfigLoggingModule(): Promise<ConfigLoggingModule> {
  configLoggingModulePromise ??= import("../config/logging.js");
  return configLoggingModulePromise;
}

function loadModelPickerModule(): Promise<ModelPickerModule> {
  modelPickerModulePromise ??= import("../commands/model-picker.js");
  return modelPickerModulePromise;
}

async function writeWizardConfigFile(config: OpenClawConfig): Promise<OpenClawConfig> {
  const committed = await commitConfigWriteWithPendingPluginInstalls({
    nextConfig: config,
    commit: async (nextConfig, writeOptions) => {
      await replaceConfigFile({
        nextConfig,
        ...(writeOptions ? { writeOptions } : {}),
        afterWrite: { mode: "auto" },
      });
    },
  });
  return committed.config;
}

async function readSetupConfigFileSnapshot() {
  return await createConfigIO({ pluginValidation: "skip" }).readConfigFileSnapshot();
}

async function resolveAuthChoiceModelSelectionPolicy(params: {
  authChoice: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolvePreferredProviderForAuthChoice: (params: {
    choice: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<string | undefined>;
}): Promise<{
  preferredProvider?: string;
  promptWhenAuthChoiceProvided: boolean;
  allowKeepCurrent: boolean;
}> {
  const preferredProvider = await params.resolvePreferredProviderForAuthChoice({
    choice: params.authChoice,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });

  const [{ resolveManifestProviderAuthChoice }, { resolvePluginSetupProvider }] = await Promise.all(
    [import("../plugins/provider-auth-choices.js"), import("../plugins/setup-registry.js")],
  );
  const manifestChoice = resolveManifestProviderAuthChoice(params.authChoice, {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
  if (manifestChoice) {
    const setupProvider = resolvePluginSetupProvider({
      provider: manifestChoice.providerId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      pluginIds: [manifestChoice.pluginId],
    });
    const setupMethod = setupProvider?.auth.find(
      (method) => normalizeProviderId(method.id) === normalizeProviderId(manifestChoice.methodId),
    );
    const setupPolicy =
      setupMethod?.wizard?.modelSelection ?? setupProvider?.wizard?.setup?.modelSelection;
    return {
      preferredProvider,
      promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
      allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true,
    };
  }

  const { resolvePluginProviders, resolveProviderPluginChoice } =
    await import("../plugins/provider-auth-choice.runtime.js");
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
  });
  const resolvedChoice = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  const matchedProvider =
    resolvedChoice?.provider ??
    (() => {
      const preferredId = preferredProvider?.trim();
      if (!preferredId) {
        return undefined;
      }
      return providers.find(
        (provider) => typeof provider.id === "string" && provider.id.trim() === preferredId,
      );
    })();
  const setupPolicy =
    resolvedChoice?.wizard?.modelSelection ?? matchedProvider?.wizard?.setup?.modelSelection;

  return {
    preferredProvider,
    promptWhenAuthChoiceProvided: setupPolicy?.promptWhenAuthChoiceProvided === true,
    allowKeepCurrent: setupPolicy?.allowKeepCurrent ?? true,
  };
}

async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(SECURITY_NOTE_MESSAGE, SECURITY_NOTE_TITLE);

  const ok = await params.prompter.confirm({
    message: SECURITY_CONFIRM_MESSAGE,
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError("risk not accepted");
  }
}

export async function runSetupWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  const onboardHelpers = await import("../commands/onboard-helpers.js");
  onboardHelpers.printWizardHeader(runtime);
  await prompter.intro("OpenClaw setup");
  await requireRiskAcknowledgement({ opts, prompter });

  const snapshot = await readSetupConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid
    ? snapshot.exists
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {}
    : {};

  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "Invalid config");
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.openclaw.ai/gateway/configuration",
        ].join("\n"),
        "Config issues",
      );
    }
    await prompter.outro(
      `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`,
    );
    runtime.exit(1);
    return;
  }

  const compatibilityNotices = snapshot.valid
    ? buildPluginCompatibilitySnapshotNotices({ config: baseConfig })
    : [];
  if (compatibilityNotices.length > 0) {
    await prompter.note(
      [
        `Detected ${compatibilityNotices.length} plugin compatibility notice${compatibilityNotices.length === 1 ? "" : "s"} in the current config.`,
        ...compatibilityNotices
          .slice(0, 4)
          .map((notice) => `- ${formatPluginCompatibilityNotice(notice)}`),
        ...(compatibilityNotices.length > 4
          ? [`- ... +${compatibilityNotices.length - 4} more`]
          : []),
        "",
        `Review: ${formatCliCommand("openclaw doctor")}`,
        `Inspect: ${formatCliCommand("openclaw plugins inspect --all")}`,
      ].join("\n"),
      "Plugin compatibility",
    );
  }

  const quickstartHint = `Configure details later via ${formatCliCommand("openclaw configure")}.`;
  const manualHint = "Configure port, network, Tailscale, and auth options.";
  const migrationDetections = await detectSetupMigrationSources({ config: baseConfig, runtime });
  const firstMigrationDetection = migrationDetections[0];
  const importOption = firstMigrationDetection
    ? {
        value: "import" as const,
        label: `Import from ${firstMigrationDetection.label}`,
        ...(firstMigrationDetection.source ? { hint: firstMigrationDetection.source } : {}),
      }
    : undefined;
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced" &&
    normalizedExplicitFlow !== "import"
  ) {
    runtime.error("Invalid --flow (use quickstart, manual, advanced, or import).");
    runtime.exit(1);
    return;
  }
  const explicitFlow: SetupFlowChoice | undefined =
    normalizedExplicitFlow === "quickstart" ||
    normalizedExplicitFlow === "advanced" ||
    normalizedExplicitFlow === "import"
      ? normalizedExplicitFlow
      : undefined;
  let flow: SetupFlowChoice =
    explicitFlow ??
    (await prompter.select({
      message: "Setup mode",
      options: [
        { value: "quickstart", label: "QuickStart", hint: quickstartHint },
        { value: "advanced", label: "Manual", hint: manualHint },
        ...(importOption ? [importOption] : []),
      ],
      initialValue: "quickstart",
    }));

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(
      "QuickStart only supports local gateways. Switching to Manual mode.",
      "QuickStart",
    );
    flow = "advanced";
  }

  if (snapshot.exists) {
    await prompter.note(
      onboardHelpers.summarizeExistingConfig(baseConfig),
      "Existing config detected",
    );

    const action = await prompter.select({
      message: "Config handling",
      options: [
        { value: "keep", label: "Use existing values" },
        { value: "modify", label: "Update values" },
        { value: "reset", label: "Reset" },
      ],
    });

    if (action === "reset") {
      const workspaceDefault =
        baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: "Reset scope",
        options: [
          { value: "config", label: "Config only" },
          {
            value: "config+creds+sessions",
            label: "Config + creds + sessions",
          },
          {
            value: "full",
            label: "Full reset (config + creds + sessions + workspace)",
          },
        ],
      })) as ResetScope;
      await onboardHelpers.handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
    }
  }

  if (opts.importFrom || flow === "import") {
    await runSetupMigrationImport({
      opts,
      baseConfig,
      detections: migrationDetections,
      prompter,
      runtime,
      commitConfigFile: writeWizardConfigFile,
    });
    return;
  }
  const wizardFlow: WizardFlow = flow;

  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback";

    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off";

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
    };
  })();

  if (flow === "quickstart") {
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return "Loopback (127.0.0.1)";
      }
      if (value === "lan") {
        return "LAN";
      }
      if (value === "custom") {
        return "Custom IP";
      }
      if (value === "tailnet") {
        return "Tailnet (Tailscale IP)";
      }
      return "Auto";
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return "Token (default)";
      }
      return "Password";
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return "Off";
      }
      if (value === "serve") {
        return "Serve";
      }
      return "Funnel";
    };
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          "Keeping your current gateway settings:",
          `Gateway port: ${quickstartGateway.port}`,
          `Gateway bind: ${formatBind(quickstartGateway.bind)}`,
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [`Gateway custom IP: ${quickstartGateway.customBindHost}`]
            : []),
          `Gateway auth: ${formatAuth(quickstartGateway.authMode)}`,
          `Tailscale exposure: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
          "Direct to chat channels.",
        ]
      : [
          `Gateway port: ${quickstartGateway.port}`,
          "Gateway bind: Loopback (127.0.0.1)",
          "Gateway auth: Token (default)",
          "Tailscale exposure: Off",
          "Direct to chat channels.",
        ];
    await prompter.note(quickstartLines.join("\n"), "QuickStart");
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  let localGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const resolvedGatewayToken = await resolveSetupSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.auth?.token,
      path: "gateway.auth.token",
      env: process.env,
    });
    if (resolvedGatewayToken) {
      localGatewayToken = resolvedGatewayToken;
    }
  } catch (error) {
    await prompter.note(
      [
        "Could not resolve gateway.auth.token SecretRef for setup probe.",
        formatErrorMessage(error),
      ].join("\n"),
      "Gateway auth",
    );
  }
  let localGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
  try {
    const resolvedGatewayPassword = await resolveSetupSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
      env: process.env,
    });
    if (resolvedGatewayPassword) {
      localGatewayPassword = resolvedGatewayPassword;
    }
  } catch (error) {
    await prompter.note(
      [
        "Could not resolve gateway.auth.password SecretRef for setup probe.",
        formatErrorMessage(error),
      ].join("\n"),
      "Gateway auth",
    );
  }

  const localProbe = await onboardHelpers.probeGatewayReachable({
    url: localUrl,
    token: localGatewayToken,
    password: localGatewayPassword,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  let remoteGatewayToken = normalizeSecretInputString(baseConfig.gateway?.remote?.token);
  try {
    const resolvedRemoteGatewayToken = await resolveSetupSecretInputString({
      config: baseConfig,
      value: baseConfig.gateway?.remote?.token,
      path: "gateway.remote.token",
      env: process.env,
    });
    if (resolvedRemoteGatewayToken) {
      remoteGatewayToken = resolvedRemoteGatewayToken;
    }
  } catch (error) {
    await prompter.note(
      [
        "Could not resolve gateway.remote.token SecretRef for setup probe.",
        formatErrorMessage(error),
      ].join("\n"),
      "Gateway auth",
    );
  }
  const remoteProbe = remoteUrl
    ? await onboardHelpers.probeGatewayReachable({
        url: remoteUrl,
        token: remoteGatewayToken,
      })
    : null;

  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: "What do you want to set up?",
          options: [
            {
              value: "local",
              label: "Local gateway (this machine)",
              hint: localProbe.ok
                ? `Gateway reachable (${localUrl})`
                : `No gateway detected (${localUrl})`,
            },
            {
              value: "remote",
              label: "Remote gateway (info-only)",
              hint: !remoteUrl
                ? "No remote URL configured yet"
                : remoteProbe?.ok
                  ? `Gateway reachable (${remoteUrl})`
                  : `Configured but unreachable (${remoteUrl})`,
            },
          ],
        })) as OnboardMode));

  if (mode === "remote") {
    const { promptRemoteGatewayConfig } = await import("../commands/onboard-remote.js");
    const { applySkipBootstrapConfig } = await import("../commands/onboard-config.js");
    const { logConfigUpdated } = await loadConfigLoggingModule();
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter, {
      secretInputMode: opts.secretInputMode,
    });
    if (opts.skipBootstrap) {
      nextConfig = applySkipBootstrapConfig(nextConfig);
    }
    nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
    nextConfig = await writeWizardConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro("Remote gateway configured.");
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await prompter.text({
          message: "Workspace directory",
          initialValue: baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);

  const { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig } =
    await import("../commands/onboard-config.js");
  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);
  if (opts.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }

  const authChoiceFromPrompt = opts.authChoice === undefined;
  let authChoice: AuthChoice | undefined = opts.authChoice;
  let authStore:
    | ReturnType<(typeof import("../agents/auth-profiles.runtime.js"))["ensureAuthProfileStore"]>
    | undefined;
  let promptAuthChoiceGrouped:
    | (typeof import("../commands/auth-choice-prompt.js"))["promptAuthChoiceGrouped"]
    | undefined;
  if (authChoiceFromPrompt) {
    const { ensureAuthProfileStore } = await import("../agents/auth-profiles.runtime.js");
    ({ promptAuthChoiceGrouped } = await import("../commands/auth-choice-prompt.js"));
    authStore = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
  }
  while (true) {
    if (authChoiceFromPrompt) {
      authChoice = await promptAuthChoiceGrouped!({
        prompter,
        store: authStore!,
        includeSkip: true,
        config: nextConfig,
        workspaceDir,
      });
    }
    if (authChoice === undefined) {
      throw new WizardCancelledError("auth choice is required");
    }

    if (authChoice === "custom-api-key") {
      const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
      const customResult = await promptCustomApiConfig({
        prompter,
        runtime,
        config: nextConfig,
        secretInputMode: opts.secretInputMode,
      });
      nextConfig = customResult.config;
      break;
    }
    if (authChoice === "skip") {
      // Explicit skip should stay cold: do not bootstrap auth/profile machinery
      // or run model/auth checks when the caller already chose to skip setup.
      if (authChoiceFromPrompt) {
        const { applyPrimaryModel, promptDefaultModel } = await loadModelPickerModule();
        const modelSelection = await promptDefaultModel({
          config: nextConfig,
          prompter,
          allowKeep: true,
          ignoreAllowlist: true,
          includeProviderPluginSetups: false,
          loadCatalog: false,
          workspaceDir,
          runtime,
        });
        if (modelSelection.config) {
          nextConfig = modelSelection.config;
        }
        if (modelSelection.model) {
          nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
        }

        const { warnIfModelConfigLooksOff } = await loadAuthChoiceModule();
        await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
      }
      break;
    }

    const [
      { applyAuthChoice, resolvePreferredProviderForAuthChoice, warnIfModelConfigLooksOff },
      { applyPrimaryModel, promptDefaultModel },
    ] = await Promise.all([loadAuthChoiceModule(), loadModelPickerModule()]);
    const authResult = await applyAuthChoice({
      authChoice,
      config: nextConfig,
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: opts.tokenProvider,
        token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
      },
    });
    nextConfig = authResult.config;
    if (authResult.retrySelection) {
      if (authChoiceFromPrompt) {
        continue;
      }
      break;
    }
    if (authResult.agentModelOverride) {
      nextConfig = applyPrimaryModel(nextConfig, authResult.agentModelOverride);
    }

    const authChoiceModelSelectionPolicy = await resolveAuthChoiceModelSelectionPolicy({
      authChoice,
      config: nextConfig,
      workspaceDir,
      resolvePreferredProviderForAuthChoice,
    });
    const shouldPromptModelSelection =
      authChoiceFromPrompt || authChoiceModelSelectionPolicy?.promptWhenAuthChoiceProvided;
    if (shouldPromptModelSelection) {
      const modelSelection = await promptDefaultModel({
        config: nextConfig,
        prompter,
        allowKeep: authChoiceModelSelectionPolicy?.allowKeepCurrent ?? true,
        ignoreAllowlist: true,
        includeProviderPluginSetups: true,
        preferredProvider: authChoiceModelSelectionPolicy?.preferredProvider,
        browseCatalogOnDemand: true,
        workspaceDir,
        runtime,
      });
      if (modelSelection.config) {
        nextConfig = modelSelection.config;
      }
      if (modelSelection.model) {
        nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
      }
    }

    await warnIfModelConfigLooksOff(nextConfig, prompter, { validateCatalog: false });
    break;
  }

  const { configureGatewayForSetup } = await import("./setup.gateway-config.js");
  const gateway = await configureGatewayForSetup({
    flow: wizardFlow,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    secretInputMode: opts.secretInputMode,
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  if (opts.skipChannels ?? opts.skipProviders) {
    await prompter.note("Skipping channel setup.", "Channels");
  } else {
    const { listChannelPlugins } = await import("../channels/plugins/index.js");
    const { setupChannels } = await import("../commands/onboard-channels.js");
    const quickstartAllowFromChannels =
      flow === "quickstart"
        ? listChannelPlugins()
            .filter((plugin) => plugin.meta.quickstartAllowFrom)
            .map((plugin) => plugin.id)
        : [];
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      deferStatusUntilSelection: flow === "quickstart",
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
  }

  nextConfig = await writeWizardConfigFile(nextConfig);
  const { logConfigUpdated } = await loadConfigLoggingModule();
  logConfigUpdated(runtime);
  await onboardHelpers.ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  // Jeenora Platform: Initialize SEO and Lead Gen Workspaces
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    // SEO Expert
    const seoDir = resolveUserPath("~/.openclaw/workspace-seo");
    await onboardHelpers.ensureWorkspaceAndSessions(seoDir, runtime, { skipBootstrap: true });
    await fs.writeFile(path.join(seoDir, "SOUL.md"), `# SOUL.md - Who You Are\n\n## Identity\nYou are the **SEO Expert** sub-agent for jeenora.com. You report to the CEO of jeenora.com. You report to the CEO of jeenora.com. Your goal is to improve the search engine rankings of jeenora.com.\n**CRITICAL RULE:** You MUST NEVER write in Tamil script (e.g., தமிழ்). You must strictly communicate using only the English alphabet to write conversational Tamil words (Tanglish). Example: "Bro, intha keyword nalla iruku".\n\n## Core Truths\nBe genuinely helpful. Have opinions. Be resourceful.`, "utf-8");
    await fs.writeFile(path.join(seoDir, "AGENTS.md"), `# AGENTS.md - SEO Workspace\n\n## SEO Workflow\nWhen the CEO asks for an SEO task, you MUST:\n1. Use your \`web_search\` and \`browser\` tools to perform keyword research, competitor analysis, or site audits.\n2. Summarize your findings in a structured Markdown file saved locally in your workspace.\n3. Reply to the CEO with your analysis.\n\n## Red Lines\n- Don't exfiltrate private data.\n- Don't run destructive commands without asking.\n- When in doubt, ask.\n`, "utf-8");

    // Lead Generator
    const leadGenDir = resolveUserPath("~/.openclaw/workspace-leadgen");
    await onboardHelpers.ensureWorkspaceAndSessions(leadGenDir, runtime, { skipBootstrap: true });
    await fs.writeFile(path.join(leadGenDir, "SOUL.md"), `# SOUL.md - Who You Are\n\n## Identity\nYou are the **Lead Generation Expert** sub-agent for jeenora.com. You report to the CEO of jeenora.com. Your goal is to find B2B fashion buyers, retailers, and boutique owners in India who might be interested in buying directly from manufacturers via Jeenora.com. You use your tools to search the web, find contact info, and generate lead lists.\n**CRITICAL RULE:** You MUST NEVER write in Tamil script (e.g., தமிழ்). You must strictly communicate using only the English alphabet to write conversational Tamil words (Tanglish). Example: "Bro, 10 leads pudichiten".\n\n## Core Truths\nBe genuinely helpful. Have opinions. Be resourceful.`, "utf-8");
    await fs.writeFile(path.join(leadGenDir, "AGENTS.md"), `# AGENTS.md - Lead Generation Workspace\n\n## Advanced Lead Gen Workflow\nWhen the CEO asks for leads, you MUST execute the following advanced process:\n\n**1. Multi-Source Scraping:**\n- Use \`web_search\` and \`browser\` to find target B2B buyers (e.g., clothing retailers in Chennai, boutique stores in India).\n- Specifically search directory listings (Justdial, IndiaMart) and social media by using smart queries like: \`site:instagram.com "boutique" "chennai" "WhatsApp"\`.\n\n**2. Data Enrichment:**\n- Extract the basic details: Store Name, Phone Number, Email, Address, Website/Social Media URL.\n- Go deeper: Identify the boutique's niche (Menswear, Womenswear, Bridal, Budget, Luxury) and find the Owner/Decision Maker's name if possible via 'About Us' pages.\n\n**3. Quality Scoring (Tiering):**\nRank every lead into one of the following tiers:\n- **Tier 1 (Hot):** Multiple branches, large website, or massive social media following. High volume B2B potential.\n- **Tier 2 (Warm):** Active social media page, single boutique shop, responsive looking.\n- **Tier 3 (Cold):** Small local map listing, limited info.\n\n**4. Outreach Script Generation:**\nFor the top 5 leads in Tier 1 or 2, generate a personalized WhatsApp/Cold-Call outreach script using Tanglish (e.g., "Hi [Owner Name], nanga Jeenora direct manufacturers..."). Add this script as a column in the final data.\n\n**5. Output Format:**\n- Save the full enriched leads in a CSV file and a summary MD file in your workspace.\n- **CRITICAL: Sending Files:** Telegram users cannot access your local workspace. To send the CSV/MD files to the user, you MUST output the exact keyword \`MEDIA:\` followed by the absolute file path on a new line (DO NOT use \`file:///\`). Example: \`MEDIA:C:/Users/admiin/.openclaw/workspace-leadgen/leads.csv\`. Do NOT use standard markdown links. ONLY this \`MEDIA:C:/...\` format triggers the file upload!\n\n## Red Lines\n- Don't exfiltrate private data.\n- Don't run destructive commands without asking.\n- When in doubt, ask.\n`, "utf-8");

    // Test Agent
    const testAgentDir = resolveUserPath("~/.openclaw/workspace-test");
    await onboardHelpers.ensureWorkspaceAndSessions(testAgentDir, runtime, { skipBootstrap: true });
    await fs.writeFile(path.join(testAgentDir, "SOUL.md"), `# SOUL.md - Who You Are\n\n## Identity\nYou are the **Lead QA, Test Automation Engineer & Security Researcher** (\`test_agent\`) for jeenora.com. You report to the CEO of jeenora.com. Your purpose is to act exactly like a human software tester and an ethical hacker. You have a "break the system" mentality. Your job is to rigorously test websites, APIs, and workflows for functional bugs, and perform comprehensive security audits (Pen Testing, Reconnaissance, OSINT) to find vulnerabilities before the bad guys do.\n**CRITICAL RULE:** You MUST NEVER write in Tamil script (e.g., தமிழ்). You must strictly communicate using only the English alphabet to write conversational Tamil words (Tanglish). Example: "Bro, intha page load aaga maatenguthu, bug kandupudichiten".\n\n## Core Truths\nBe meticulous. Trust nothing, test everything. Write crystal-clear bug reports.`, "utf-8");
    await fs.writeFile(path.join(testAgentDir, "AGENTS.md"), `# AGENTS.md - Test Workspace\n\n## QA Testing Workflow\nWhen the CEO delegates a task to you, you MUST act like a human QA tester:\n\n**1. Understand & Plan:**\n- Analyze the requirements given by the CEO.\n- Formulate a test plan (Happy path, Edge cases, Negative testing).\n\n**2. Manual UI/API Testing (QA):**\n- Use the \`browser\` tool to visually navigate websites, click buttons, fill forms, and look for UI/UX glitches.\n- Use \`web_fetch\` or the \`exec\` tool (curl) to test API endpoints for speed, correct HTTP codes, and valid JSON responses.\n\n**3. Security Testing & Penetration Audits (SecOps):**\nWhen asked to perform security testing, utilize your tools (\`exec\`, \`web_search\`, \`browser\`) to run the following playbooks:\n- **Network Recon:** Run \`nmap\` (if installed) or use web-based WHOIS/DNS Dumpster to find subdomains and open ports.\n- **Web App Vulnerability Scans:** Run tools like Nikto, ZAP, WPScan, Dirb/Gobuster, SQLMap, or XSStrike (if available) to detect injections and hidden files.\n- **Security Headers & Configs:** Check HTTP headers for missing HSTS, CSP, X-Frame-Options, CORS issues, and secure Cookie flags. Validate SSL/TLS certs.\n- **OSINT:** Use Google Dorking, Wayback Machine, theHarvester, or Shodan to find exposed data, admin panels, or historical secrets.\n- **Social Engineering:** Check SPF/DKIM/DMARC records to prevent email spoofing.\n\n**4. Test Automation & Execution:**\n- If code is involved, use \`exec\` to run standard test suites (\`npm run test\`, \`pytest\`, etc.).\n\n**5. Bug Reporting:**\n- If a test fails, you MUST write a professional Bug/Vulnerability Report.\n- A Bug Report must include: \n  - **Issue Summary:** What went wrong / Security Risk.\n  - **Steps to Reproduce:** 1... 2... 3...\n  - **Expected Result vs Actual Result.**\n  - **Environment/URL tested.**\n\n**6. Deliverables:**\n- Save your Bug Reports or Test Summaries as an MD file in your workspace.\n- To send the file to the user, you MUST use the exact keyword \`MEDIA:\` followed by the absolute file path on a new line. Example: \`MEDIA:C:/Users/admiin/.openclaw/workspace-test/test_report.md\`. Do NOT use standard markdown links and DO NOT use \`file:///\`.\n\n## Red Lines\n- Don't exfiltrate private data.\n- Don't run destructive commands without asking.\n- When in doubt, ask.\n`, "utf-8");

  } catch (err) {
    runtime.log(`Failed to initialize Subagent workspaces: ${err}`);
  }

  if (opts.skipSearch) {
    await prompter.note("Skipping search setup.", "Search");
  } else {
    const { setupSearch } = await import("../commands/onboard-search.js");
    nextConfig = await setupSearch(nextConfig, runtime, prompter, {
      quickstartDefaults: flow === "quickstart",
      secretInputMode: opts.secretInputMode,
    });
  }

  if (opts.skipSkills) {
    await prompter.note("Skipping skills setup.", "Skills");
  } else {
    const { setupSkills } = await import("../commands/onboard-skills.js");
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // Plugin configuration (sandbox backends, tool plugins, etc.)
  if (flow !== "quickstart") {
    const { setupPluginConfig } = await import("./setup.plugin-config.js");
    nextConfig = await setupPluginConfig({
      config: nextConfig,
      prompter,
      workspaceDir,
    });
  }

  // Setup hooks (session memory on /new)
  const { setupInternalHooks } = await import("../commands/onboard-hooks.js");
  nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);

  nextConfig = onboardHelpers.applyWizardMetadata(nextConfig, { command: "onboard", mode });
  nextConfig = await writeWizardConfigFile(nextConfig);

  const { finalizeSetupWizard } = await import("./setup.finalize.js");
  const { launchedTui } = await finalizeSetupWizard({
    flow: wizardFlow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });
  if (launchedTui) {
    return;
  }
}
