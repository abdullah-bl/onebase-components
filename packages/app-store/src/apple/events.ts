// Turns verified App Store payloads into store events. Nothing here trusts a
// payload that has not been through `verifyAppleJws`. The event shape follows
// the ShaSha app's `apply_store_event` contract, so billing code stays portable.

import { verifyAppleJws, type VerifyOptions } from "./jws";

export type StoreEventsConfig = {
  /** The app's bundle id; transactions and notifications for other apps are ignored. */
  bundleId: string;
  /** Product ids this app sells; anything else is ignored. */
  products: string[];
};

export type TransactionInfo = {
  bundleId?: string;
  productId?: string;
  transactionId?: string;
  originalTransactionId?: string;
  appAccountToken?: string;
  expiresDate?: number;
  revocationDate?: number;
  offerType?: number;
  environment?: string;
  signedDate?: number;
};

export type NotificationPayload = {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
  };
};

export type StoreEvent = {
  id: string;
  type: string;
  app_user_id: string | null;
  product_id: string;
  period_type: "TRIAL" | "NORMAL";
  expiration_at_ms: number | null;
  original_transaction_id: string | null;
  transaction_id: string | null;
  environment: "PRODUCTION" | "SANDBOX";
  event_at_ms: number | null;
};

/** Maps an App Store notification type to the event type the store knows, or null to ignore it. */
export function notificationEventType(type: string | undefined, subtype?: string): string | null {
  switch (type) {
    case "SUBSCRIBED":
      return "INITIAL_PURCHASE";
    case "DID_RENEW":
    case "OFFER_REDEEMED":
      return "RENEWAL";
    case "DID_CHANGE_RENEWAL_PREF":
      return subtype === "UPGRADE" ? "PRODUCT_CHANGE" : null;
    case "DID_CHANGE_RENEWAL_STATUS":
      return subtype === "AUTO_RENEW_DISABLED" ? "CANCELLATION" : subtype === "AUTO_RENEW_ENABLED" ? "UNCANCELLATION" : null;
    case "DID_FAIL_TO_RENEW":
      return "BILLING_ISSUE";
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return "EXPIRATION";
    case "REFUND":
    case "REVOKE":
      return "REFUND";
    case "RENEWAL_EXTENDED":
    case "RENEWAL_EXTENSION":
      return "SUBSCRIPTION_EXTENDED";
    default:
      return null;
  }
}

export type StoreEventsOptions = VerifyOptions;

export type NotificationResult =
  | { kind: "ignored"; reason: string }
  | { kind: "event"; event: StoreEvent };

/**
 * Binds the pure event mapping to one app's bundle id and product list. The
 * options are for tests: a generated root certificate and skipping Apple's
 * marker extensions.
 */
export function createStoreEvents(config: StoreEventsConfig, options: StoreEventsOptions = {}) {
  const products = new Set(config.products);
  const verify = <T extends object>(jws: string) => verifyAppleJws<T>(jws, options);

  const verifyTransaction = (jws: string) => verify<TransactionInfo>(jws);

  /** A transaction this app may act on: ours, a known product, not revoked. */
  const isUsableTransaction = (tx: TransactionInfo): boolean =>
    tx.bundleId === config.bundleId &&
    typeof tx.productId === "string" &&
    products.has(tx.productId) &&
    typeof tx.originalTransactionId === "string" &&
    tx.revocationDate === undefined;

  function environmentOf(value: string | undefined): StoreEvent["environment"] {
    const lower = (value ?? "").toLowerCase();
    return lower === "production" || lower === "prod" ? "PRODUCTION" : "SANDBOX";
  }

  function eventFrom(tx: TransactionInfo, id: string, type: string, eventAt: number | null): StoreEvent {
    return {
      id,
      type,
      app_user_id: tx.appAccountToken ? tx.appAccountToken.toLowerCase() : null,
      product_id: tx.productId ?? "",
      // offerType 1 is an introductory offer — a trial.
      period_type: tx.offerType === 1 ? "TRIAL" : "NORMAL",
      expiration_at_ms: typeof tx.expiresDate === "number" ? tx.expiresDate : null,
      original_transaction_id: tx.originalTransactionId ?? null,
      transaction_id: tx.transactionId ?? null,
      environment: environmentOf(tx.environment),
      event_at_ms: eventAt,
    };
  }

  /**
   * What the app can see right now, reported as a SYNC event. It carries the time
   * Apple signed the transaction, so one saved from before a refund is stale.
   */
  const syncEvent = (tx: TransactionInfo): StoreEvent =>
    eventFrom(
      tx,
      `sync:${tx.originalTransactionId}:${tx.transactionId}:${tx.expiresDate ?? 0}`,
      "SYNC",
      typeof tx.signedDate === "number" ? tx.signedDate : null,
    );

  /** Verifies a notification and its embedded transaction, and maps it to one event. */
  async function eventFromNotification(signedPayload: string): Promise<NotificationResult> {
    const notification = await verify<NotificationPayload>(signedPayload);
    if (!notification.notificationUUID) return { kind: "ignored", reason: "no notification id" };
    const data = notification.data;
    if (!data || data.bundleId !== config.bundleId) return { kind: "ignored", reason: "other app" };

    const type = notificationEventType(notification.notificationType, notification.subtype);
    if (!type) return { kind: "ignored", reason: "not a billing change" };
    if (!data.signedTransactionInfo) return { kind: "ignored", reason: "no transaction" };

    const tx = await verifyTransaction(data.signedTransactionInfo);
    if (tx.bundleId !== config.bundleId || !tx.productId || !products.has(tx.productId)) {
      return { kind: "ignored", reason: "unknown product" };
    }
    if (!tx.originalTransactionId) return { kind: "ignored", reason: "no original transaction" };

    const event = eventFrom(
      { ...tx, environment: tx.environment ?? data.environment },
      notification.notificationUUID,
      type,
      typeof notification.signedDate === "number" ? notification.signedDate : null,
    );
    return { kind: "event", event };
  }

  return { verifyTransaction, isUsableTransaction, syncEvent, eventFromNotification };
}

export type StoreEvents = ReturnType<typeof createStoreEvents>;
