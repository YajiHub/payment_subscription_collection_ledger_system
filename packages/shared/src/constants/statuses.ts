// Lifecycle values shared by the client and the server.
// The database schema must use exactly these strings so no translation layer is needed.

export const SUBSCRIBER_STATUSES = ["active", "suspended", "disconnected"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

export const INVOICE_STATUSES = ["draft", "issued", "partially_paid", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ["cash", "gcash", "bank_transfer", "check"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const COLLECTION_BATCH_STATUSES = ["open", "remitted", "reconciled"] as const;
export type CollectionBatchStatus = (typeof COLLECTION_BATCH_STATUSES)[number];