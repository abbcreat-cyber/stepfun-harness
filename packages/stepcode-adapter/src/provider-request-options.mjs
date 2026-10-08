import { randomUUID } from "node:crypto";
import { COMMUNICATION_COMMAND, requiresProviderCommunication } from "./provider-communication.mjs";

export const OPTIONS_RECEIPT_KEY = "stepcode-provider-options-receipt";
const bindings = new WeakMap();
const unmapped = () => ({ hasMappings: false, reasoningMapped: false, maxOutputMapped: false });

function nativeClient(client) {
  if (!client?.options) return false;
  return requiresProviderCommunication(client.options);
}

async function exchange(client, input) {
  if (!nativeClient(client)) return unmapped();
  const child = client.child;
  if (!child || !client.isRunning()) throw new Error("Provider options require a running client");
  const known = bindings.get(client),
    nonce = randomUUID();
  if (known && known.child !== child) bindings.delete(client);
  const envelope = {
    ...input,
    nonce,
    generation: known?.child === child ? known.generation : undefined,
  };
  let settle, offEvent, offFailure, timer;
  const receiptPromise = new Promise((resolve, reject) => {
    settle = (error, receipt) => (error ? reject(error) : resolve(receipt));
    offEvent = client.onEvent((event) => {
      if (
        event.type !== "extension_ui_request" ||
        event.method !== "setStatus" ||
        event.statusKey !== OPTIONS_RECEIPT_KEY
      )
        return;
      let receipt;
      try {
        receipt = JSON.parse(event.statusText);
      } catch {
        return;
      }
      if (receipt.nonce !== nonce) return;
      if (receipt.error) settle(new Error(receipt.error));
      else settle(undefined, receipt);
    });
    offFailure = client.onFailure?.((error) => settle(error));
    timer = setTimeout(
      () => settle(new Error("Provider option receipt was not received; request is blocked")),
      8000,
    );
  });
  try {
    const [, receipt] = await Promise.all([
      client
        .request({
          type: "prompt",
          message: `/${COMMUNICATION_COMMAND} ${JSON.stringify(envelope)}`,
        })
        .then((response) => {
          if (!response.success)
            throw new Error(response.error ?? "Provider option command failed");
        }),
      receiptPromise,
    ]);
    if (
      client.child !== child ||
      receipt.version !== 1 ||
      receipt.providerId !== input.providerId ||
      receipt.modelId !== input.modelId ||
      typeof receipt.generation !== "string" ||
      (envelope.generation && envelope.generation !== receipt.generation) ||
      receipt.requestId !== input.requestId
    )
      throw new Error("Provider option receipt does not match the client/model binding");
    bindings.set(client, { child, generation: receipt.generation });
    return receipt;
  } finally {
    clearTimeout(timer);
    offEvent?.();
    offFailure?.();
  }
}

export function hasMappedProviderOptions(client, selection) {
  return exchange(client, {
    action: "describe",
    providerId: selection.providerId,
    modelId: selection.modelId,
    requestId: randomUUID(),
  });
}

/** owner 在模型落定与实际 prompt 之间调用；不产生第二份选择或队列状态。 */
export async function prepareProviderRequestOptions(
  client,
  { providerId, modelId, options, requestId = randomUUID() },
) {
  try {
    return await exchange(client, { action: "prepare", providerId, modelId, options, requestId });
  } catch (error) {
    try {
      await discardProviderRequestOptions(client, { providerId, modelId, requestId });
    } catch {
      error.providerOptionsUncertain = true;
    }
    throw error;
  }
}

export function discardProviderRequestOptions(client, { providerId, modelId, requestId }) {
  return exchange(client, { action: "discard", providerId, modelId, requestId });
}

export async function carryProviderRequestOptions(
  client,
  { providerId, modelId, options, requestId },
) {
  try {
    return await exchange(client, { action: "carry", providerId, modelId, options, requestId });
  } catch (error) {
    try {
      await discardProviderRequestOptions(client, { providerId, modelId, requestId });
    } catch {
      error.providerOptionsUncertain = true;
    }
    throw error;
  }
}
