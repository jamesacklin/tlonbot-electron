type TlonbotApi = {
  getArchitecture: () => Promise<string>;
  downloadVere: () => Promise<{ success: boolean; error?: string }>;
  bootMoon: (
    moonId: string,
    moonKey: string
  ) => Promise<{ success: boolean; code?: string; error?: string }>;
  saveConfig: (config: Record<string, unknown>) => Promise<{ success: boolean }>;
  finishSetup: () => Promise<{
    success: boolean;
    gatewayUrl?: string;
    error?: string;
  }>;
  getConfig: () => Promise<Record<string, unknown>>;
  getStatus: () => Promise<Record<string, unknown>>;
  onProgress: (callback: (percent: number) => void) => () => void;
  onStatus: (callback: (status: string) => void) => () => void;
  onBootLog: (callback: (message: string) => void) => () => void;
};

type TlonbotWindow = Window & {
  tlonbot: TlonbotApi;
};

let currentStep = 0;
const totalSteps = 5;
const tlonbotBridge = (window as unknown as TlonbotWindow).tlonbot;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function showStep(step: number): void {
  for (let i = 0; i < totalSteps; i++) {
    const el = $(`step-${i}`);
    const dot = document.querySelector(`.step-dot[data-step="${i}"]`) as HTMLElement;
    el.classList.toggle("active", i === step);
    dot.classList.toggle("active", i === step);
    dot.classList.toggle("done", i < step);
  }
  currentStep = step;
}

function nextStep(): void {
  if (currentStep === 1) {
    // Validate credentials before moving forward
    if (!validateCredentials()) return;
    saveCredentials();
  }
  if (currentStep === 2) {
    if (!validateApiConfig()) return;
    saveApiConfig();
  }
  if (currentStep === 3) {
    // Don't allow manual next during boot
    return;
  }
  showStep(currentStep + 1);

  if (currentStep === 3) {
    initBootStep();
  }
}

function prevStep(): void {
  if (currentStep > 0) {
    showStep(currentStep - 1);
  }
}

function validateCredentials(): boolean {
  const ownerShip = ($("owner-ship") as HTMLInputElement).value.trim();
  const moonId = ($("moon-id") as HTMLInputElement).value.trim();
  const moonKey = ($("moon-key") as HTMLInputElement).value.trim();

  if (!ownerShip || !moonId || !moonKey) {
    alert("Please fill in all credential fields.");
    return false;
  }

  if (!ownerShip.startsWith("~")) {
    alert("Owner ship should start with ~ (e.g., ~sampel-palnet)");
    return false;
  }

  if (!moonId.startsWith("~")) {
    alert("Moon name should start with ~ (e.g., ~mipbur-moswep-sampel-palnet)");
    return false;
  }

  return true;
}

function saveCredentials(): void {
  const ownerShip = ($("owner-ship") as HTMLInputElement).value.trim();
  const moonId = ($("moon-id") as HTMLInputElement).value.trim();
  const moonKey = ($("moon-key") as HTMLInputElement).value.trim();

  tlonbotBridge.saveConfig({ ownerShip, moonId, moonKey });
}

function saveApiConfig(): void {
  const provider = (
    document.querySelector(
      'input[name="provider"]:checked'
    ) as HTMLInputElement
  ).value;
  const apiKey = ($("api-key") as HTMLInputElement).value.trim();
  const model = resolveModelSelection(provider);

  tlonbotBridge.saveConfig({ apiProvider: provider, apiKey, model });
}

function providerLabel(provider: string): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openrouter") return "OpenRouter";
  return "MiniMax";
}

function providerModelPrefix(provider: string): string {
  if (provider === "anthropic") return "anthropic/";
  if (provider === "openrouter") return "openrouter/";
  return "minimax/";
}

function validateApiConfig(): boolean {
  const provider = (
    document.querySelector('input[name="provider"]:checked') as HTMLInputElement
  ).value;
  const apiKey = ($("api-key") as HTMLInputElement).value.trim();

  if (!apiKey) {
    alert(`${providerLabel(provider)} API key is required to continue.`);
    return false;
  }

  if (provider === "openrouter") {
    const openrouterModelId = ($("openrouter-model-id") as HTMLInputElement).value.trim();
    if (!openrouterModelId) {
      alert("Please enter an OpenRouter model identifier.");
      return false;
    }
    return true;
  }

  const model = ($("model-select") as HTMLSelectElement).value;
  const requiredPrefix = providerModelPrefix(provider);
  if (!model.startsWith(requiredPrefix)) {
    alert(`Please choose a ${providerLabel(provider)} model.`);
    return false;
  }

  return true;
}

async function initBootStep(): Promise<void> {
  const arch = await tlonbotBridge.getArchitecture();
  $("arch-label").textContent = `Detected: ${arch}. Will download the matching Urbit runtime.`;
}

const modelCatalog = Array.from(($("model-select") as HTMLSelectElement).options).map((option) => ({
  value: option.value,
  label: option.textContent ?? option.value,
}));

function syncModelOptions(provider: string): void {
  const modelSelect = $("model-select") as HTMLSelectElement;
  const currentValue = modelSelect.value;
  const requiredPrefix = providerModelPrefix(provider);
  const providerModels = modelCatalog.filter((model) => model.value.startsWith(requiredPrefix));

  modelSelect.innerHTML = "";
  for (const model of providerModels) {
    const option = document.createElement("option");
    option.value = model.value;
    option.textContent = model.label;
    modelSelect.appendChild(option);
  }

  if (providerModels.length === 0) {
    return;
  }

  const selectedValue = providerModels.some((model) => model.value === currentValue)
    ? currentValue
    : providerModels[0].value;
  modelSelect.value = selectedValue;
}

function normalizeOpenRouterModel(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "openrouter/auto";
  }
  return trimmed.startsWith("openrouter/") ? trimmed : `openrouter/${trimmed}`;
}

function resolveModelSelection(provider: string): string {
  if (provider === "openrouter") {
    const modelId = ($("openrouter-model-id") as HTMLInputElement).value;
    return normalizeOpenRouterModel(modelId);
  }
  return ($("model-select") as HTMLSelectElement).value;
}

function updateProviderUi(provider: string): void {
  const apiKeySection = $("api-key-section");
  const apiKeyInput = $("api-key") as HTMLInputElement;
  const apiKeyHint = $("api-key-hint");
  const modelSelectRow = $("model-select-row");
  const openrouterModelRow = $("openrouter-model-row");
  const openrouterModelInput = $("openrouter-model-id") as HTMLInputElement;

  // Keep key entry visible for all providers.
  apiKeySection.classList.add("visible");

  if (provider === "minimax") {
    modelSelectRow.style.display = "block";
    openrouterModelRow.style.display = "none";
    syncModelOptions(provider);
    apiKeyInput.placeholder = "Enter your MiniMax API key";
    apiKeyHint.textContent = "Required: Tlonbot does not include model credits or bundled API access.";
    return;
  }

  if (provider === "anthropic") {
    modelSelectRow.style.display = "block";
    openrouterModelRow.style.display = "none";
    syncModelOptions(provider);
    apiKeyInput.placeholder = "Enter your Anthropic API key";
    apiKeyHint.textContent = "Required: Tlonbot does not include model credits or bundled API access.";
    return;
  }

  modelSelectRow.style.display = "none";
  openrouterModelRow.style.display = "block";
  if (!openrouterModelInput.value.trim()) {
    openrouterModelInput.value = "auto";
  }
  apiKeyInput.placeholder = "Enter your OpenRouter API key";
  apiKeyHint.textContent = "Required: Tlonbot does not include model credits or bundled API access.";
}

// Provider radio toggle
document.querySelectorAll('input[name="provider"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const value = (radio as HTMLInputElement).value;
    updateProviderUi(value);
  });
});

const selectedProvider = document.querySelector(
  'input[name="provider"]:checked'
) as HTMLInputElement | null;
if (selectedProvider) {
  updateProviderUi(selectedProvider.value);
}

async function startDownloadAndBoot(): Promise<void> {
  const btn = $("btn-boot") as HTMLButtonElement;
  const btnBack = $("btn-back-boot") as HTMLButtonElement;
  btn.disabled = true;
  btnBack.disabled = true;

  const progressFill = $("progress-fill") as HTMLElement;
  const progressLabel = $("progress-label") as HTMLElement;
  const statusMessage = $("status-message") as HTMLElement;
  const errorMessage = $("error-message") as HTMLElement;
  const logOutput = $("log-output") as HTMLElement;

  errorMessage.style.display = "none";
  logOutput.textContent = "";

  // Subscribe to events
  const cleanupProgress = tlonbotBridge.onProgress((percent: number) => {
    progressFill.style.width = `${percent}%`;
    progressLabel.textContent = `Downloading... ${percent}%`;
  });

  const cleanupStatus = tlonbotBridge.onStatus((status: string) => {
    statusMessage.textContent = status;
  });

  const cleanupLog = tlonbotBridge.onBootLog((message: string) => {
    logOutput.textContent += message + "\n";
    logOutput.scrollTop = logOutput.scrollHeight;
  });

  try {
    // Step 1: Download vere
    statusMessage.textContent = "Downloading Urbit runtime...";
    const dlResult = await tlonbotBridge.downloadVere();
    if (!dlResult.success) {
      throw new Error(dlResult.error || "Download failed");
    }
    progressFill.style.width = "100%";
    progressLabel.textContent = "Download complete";

    // Step 2: Boot moon
    statusMessage.textContent = "Booting moon (this may take a few minutes)...";
    const config = (await tlonbotBridge.getConfig()) as { moonId: string; moonKey: string };
    const bootResult = await tlonbotBridge.bootMoon(config.moonId, config.moonKey);
    if (!bootResult.success) {
      throw new Error(bootResult.error || "Boot failed");
    }

    statusMessage.textContent = "Moon booted! Finishing setup...";

    // Step 3: Finish setup (generate config, start openclaw)
    const setupResult = await tlonbotBridge.finishSetup();
    if (!setupResult.success) {
      throw new Error(setupResult.error || "Setup failed");
    }

    // Move to done step
    if (setupResult.gatewayUrl) {
      $("gateway-url").textContent = setupResult.gatewayUrl;
    }
    showStep(4);
  } catch (err: any) {
    errorMessage.textContent = `Error: ${err.message}`;
    errorMessage.style.display = "block";
    btn.disabled = false;
    btnBack.disabled = false;
    btn.textContent = "Retry";
  } finally {
    cleanupProgress();
    cleanupStatus();
    cleanupLog();
  }
}

function finishWizard(): void {
  // Close the setup window - tray will take over
  window.close();
}

function wireButtons(): void {
  $("btn-step-0-next").addEventListener("click", nextStep);
  $("btn-step-1-back").addEventListener("click", prevStep);
  $("btn-step-1-next").addEventListener("click", nextStep);
  $("btn-step-2-back").addEventListener("click", prevStep);
  $("btn-step-2-next").addEventListener("click", nextStep);
  $("btn-back-boot").addEventListener("click", prevStep);
  $("btn-boot").addEventListener("click", () => {
    void startDownloadAndBoot();
  });
  $("btn-finish").addEventListener("click", finishWizard);
}

wireButtons();
