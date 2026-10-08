import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const COMMUNICATION_COMMAND = "stepcode-provider-communication-v1";
export const COMMUNICATION_DESCRIPTION =
  "Step desktop provider communication v1: native stream guard, headers, payload and SSE transport";
const APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const AUTH_HEADERS = ["authorization", "x-api-key", "cf-aig-authorization"];
const PROTECTED_BODY = new Set(["model", "messages", "input", "stream", "tools", "tool_choice"]);

export function requiresProviderCommunication(options = {}) {
  const mode = options.communicationMode ?? "required";
  if (!["required", "mock"].includes(mode)) throw new Error("Invalid provider communication mode");
  // 类型是 RPC backend 契约，不能用可执行文件 basename 判断；生产 Host 不允许降级。
  if (
    options.env?.STEP_BACKEND === "stepcode-local" ||
    process.env.STEP_BACKEND === "stepcode-local"
  )
    return true;
  return mode === "required";
}

export function withProviderCommunication(command, options = {}) {
  if (!Array.isArray(command) || !command.length || !requiresProviderCommunication(options))
    return command;
  const extension = fileURLToPath(
    new URL("./extensions/provider-communication.mjs", import.meta.url),
  );
  if (!existsSync(extension)) throw new Error("Provider communication extension is missing");
  return command.includes(extension) ? command : [...command, "--extension", extension];
}

export async function assertProviderCommunicationLoaded(client) {
  if (!requiresProviderCommunication(client.options)) return;
  const commands = await client.getCommands();
  if (
    !commands.some(
      (item) =>
        item.name === COMMUNICATION_COMMAND &&
        item.description === COMMUNICATION_DESCRIPTION &&
        item.source === "extension",
    )
  )
    throw new Error("Provider communication extension failed to initialize; request is blocked");
}

function canonicalRoot(value, api) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.search || url.hash || url.username || url.password)
    throw new Error("Provider communication binding has an unsupported API root");
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|responses|messages)$/, "");
  if (api === "anthropic-messages") url.pathname = url.pathname.replace(/\/v1$/, "");
  return url.href.replace(/\/$/, "");
}

export function communicationBinding(model, expected) {
  const metadata = model?.compat?.stepcodeDesktop;
  if (!metadata) {
    if (expected) throw new Error("Provider communication binding metadata was removed");
    return undefined;
  }
  if (metadata.version !== 1)
    throw new Error("Provider communication metadata version is unsupported");
  if (!APIS.has(metadata.protocol) || !["api-key", "headers", "none"].includes(metadata.authMode))
    throw new Error("Provider communication binding protocol/auth mode is invalid");
  if (
    metadata.providerId !== model.provider ||
    metadata.modelId !== model.id ||
    metadata.protocol !== model.api ||
    canonicalRoot(metadata.apiRoot, model.api) !== canonicalRoot(model.baseUrl, model.api)
  )
    throw new Error("Provider communication binding does not match the SDK model");
  if (metadata.supportsToolCall !== undefined && typeof metadata.supportsToolCall !== "boolean")
    throw new Error("Provider communication tool capability is invalid");
  const result = structuredClone(metadata);
  if (expected && JSON.stringify(result) !== JSON.stringify(expected))
    throw new Error("Provider communication startup binding generation changed");
  return result;
}

export function applyCommunicationHeaders(headers, model, binding) {
  if (!binding || binding.authMode === "api-key") return headers;
  const explicit = new Map();
  // SDK Model 的 headers 为空，显式 provider/model 头在预先合成的 ModelAuth headers 中。
  if (binding.authMode === "headers")
    for (const [name, value] of Object.entries(model.headers ?? headers))
      if (AUTH_HEADERS.includes(name.toLowerCase())) explicit.set(name.toLowerCase(), value);
  for (const name of Object.keys(headers))
    if (AUTH_HEADERS.includes(name.toLowerCase())) delete headers[name];
  for (const name of AUTH_HEADERS)
    headers[name === "authorization" ? "Authorization" : name] = explicit.get(name) ?? null;
  return headers;
}

function assertJson(value, depth = 0) {
  if (depth > 16) throw new Error("Provider sampling parameters are too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    !value ||
    typeof value !== "object" ||
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new Error("Provider sampling parameters must be finite JSON");
  for (const [name, part] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(name))
      throw new Error("Provider sampling parameter key is invalid");
    assertJson(part, depth + 1);
  }
}

export function applyCommunicationPayload(payload, model, binding) {
  if (!binding) return payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.model !== model.id ||
    payload.stream !== true
  )
    throw new Error("Provider communication payload identity is invalid");
  const sampling = model.samplingParams ?? {};
  assertJson(sampling);
  if (
    Array.isArray(sampling) ||
    typeof sampling !== "object" ||
    sampling === null ||
    JSON.stringify(sampling).length > 65536
  )
    throw new Error("Provider sampling parameters must be a bounded JSON object");
  for (const name of Object.keys(sampling))
    if (
      PROTECTED_BODY.has(name) ||
      (model.api === "anthropic-messages" && name === "parallel_tool_calls")
    )
      throw new Error(`Provider sampling parameter '${name}' is protected`);
  const next = {
    ...payload,
    ...(model.api === "anthropic-messages" ? structuredClone(sampling) : {}),
  };
  if (binding.supportsToolCall === false)
    for (const name of ["tools", "tool_choice", "parallel_tool_calls"]) delete next[name];
  return next;
}

/** 在 SDK fetch 接点最后清理 SDK 自动加入的认证；占位值只用于本地 credential gate。 */
export function communicationFetch(
  fetchImpl,
  model,
  binding,
  normalizeResponse = (value) => value,
  requestHeaders,
) {
  return async (input, init) => {
    communicationBinding(model, binding);
    const requestUrl = input instanceof Request ? input.url : String(input);
    if (canonicalRoot(requestUrl, model.api) !== canonicalRoot(binding.apiRoot, model.api))
      throw new Error("Provider communication HTTP target does not match the startup binding");
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (binding.authMode !== "api-key") {
      const explicit = {};
      applyCommunicationHeaders(
        explicit,
        { ...model, headers: requestHeaders ?? model.headers },
        binding,
      );
      for (const name of AUTH_HEADERS) {
        headers.delete(name);
        const value = explicit[name === "authorization" ? "Authorization" : name];
        if (value !== null && value !== undefined) headers.set(name, value);
      }
    }
    for (const value of headers.values())
      if (value.includes("__stepcode_internal_auth_gate__"))
        throw new Error("Provider internal credential gate must never be sent as an HTTP header");
    return normalizeResponse(await fetchImpl(input, { ...init, headers }));
  };
}
