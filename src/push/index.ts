import { defaultRegistryDir } from "../registry/index.js";
import { messageOf } from "../messageOf.js";
import { AttentionPusher, webPushSender } from "./notifier.js";
import { SubscriptionStore } from "./subscriptions.js";
import { loadOrCreateVapid } from "./vapid.js";

export interface PushSetup {
  store: SubscriptionStore;
  publicKey: string;
  /** Builds the sender for one Project Server. */
  pusherFor(project: { projectId: string; projectName: string }): AttentionPusher;
}

/** Keys and subscriptions live next to the Instance Registry. Unusable keys disable push; the server and in-tab alerts carry on. */
export function setupPush(onWarn: (message: string) => void, dir: string = defaultRegistryDir()): PushSetup | undefined {
  try {
    const keys = loadOrCreateVapid(dir);
    const store = new SubscriptionStore(dir);
    const send = webPushSender(keys);
    return {
      store,
      publicKey: keys.publicKey,
      pusherFor: (project) => new AttentionPusher({ store, send, ...project, onError: onWarn }),
    };
  } catch (cause) {
    onWarn(`web push disabled: ${messageOf(cause)}`);
    return undefined;
  }
}
