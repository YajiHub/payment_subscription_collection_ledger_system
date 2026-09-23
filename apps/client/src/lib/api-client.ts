// The ONLY place in the renderer that performs HTTP.
//
// The sandboxed renderer has no database driver and no raw sockets: every piece
// of data the UI shows must arrive through a function in this file.
// Domain endpoints answer with the { success, data } envelope; helpers below
// unwrap it so callers work with the payload directly.

import axios, { AxiosError } from "axios";

import type {
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  PaymentStatus,
  PostablePaymentMethod,
  ServiceAccountStatus,
  ServiceType,
  UserRole,
} from "@bcis/shared";
import { API_BASE_URL, HTTP_TIMEOUT_MS } from "./constants";
import { useAuthStore } from "../stores/auth.store";

const httpClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: HTTP_TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

// Attach the bearer token to every request once the user is logged in.
httpClient.interceptors.request.use((requestConfig) => {
  const token = useAuthStore.getState().token;
  if (token !== null) {
    requestConfig.headers.Authorization = `Bearer ${token}`;
  }
  return requestConfig;
});

// A 401 means the session is no longer valid — clear it so the UI redirects to login.
httpClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

interface ApiSuccessEnvelope<TData> {
  success: true;
  data: TData;
}

interface ApiErrorEnvelope {
  success: false;
  error: { code: string; message: string };
}

/** Turns any thrown error into a message a human can read in the UI. */
export function extractApiErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const body = error.response?.data as ApiErrorEnvelope | undefined;
    if (body?.error?.message !== undefined) {
      return body.error.message;
    }
    if (error.code === "ECONNABORTED") {
      return "The server took too long to respond.";
    }
    return "Unable to reach the server. Check that it is running.";
  }
  return "Something went wrong. Please try again.";
}

function unwrap<TData>(envelope: ApiSuccessEnvelope<TData>): TData {
  return envelope.data;
}

export interface ServiceHealth {
  status: "ok";
  timestamp: string;
  version: string;
}

export interface DatabaseHealth {
  status: "ok" | "error";
  latency_ms: number;
  error?: string | null;
}

/** Asks the API server whether the process is alive. Throws when unreachable. */
export async function fetchServiceHealth(): Promise<ServiceHealth> {
  const response = await httpClient.get<ServiceHealth>("/health");
  return response.data;
}

/** Asks the API server to confirm it can reach PostgreSQL. */
export async function fetchDatabaseHealth(): Promise<DatabaseHealth> {
  const response = await httpClient.get<DatabaseHealth>("/health/db");
  return response.data;
}

export interface AuthenticatedUserProfile {
  id: string;
  fullName: string;
  username: string;
  role: UserRole;
  isActive: boolean;
}

export interface LoginResult {
  token: string;
  user: { id: string; fullName: string; role: UserRole };
}

/** POST /api/auth/login — exchanges credentials for a token. */
export async function login(username: string, password: string): Promise<LoginResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<LoginResult>>("/api/auth/login", {
    username,
    password,
  });
  return unwrap(response.data);
}

/** POST /api/auth/logout — revokes the current token on the server. */
export async function logout(): Promise<void> {
  await httpClient.post("/api/auth/logout");
}

/** GET /api/auth/me — the profile of the currently authenticated user. */
export async function fetchCurrentUser(): Promise<AuthenticatedUserProfile> {
  const response =
    await httpClient.get<ApiSuccessEnvelope<AuthenticatedUserProfile>>("/api/auth/me");
  return unwrap(response.data);
}

export interface ManagedUser {
  id: string;
  fullName: string;
  username: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedUsers {
  items: ManagedUser[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreateUserInput {
  fullName: string;
  username: string;
  password: string;
  role: UserRole;
}

export interface UpdateUserInput {
  fullName?: string;
  role?: UserRole;
}

/** GET /api/users — one page of users (Admin only). */
export async function listUsers(page = 1, pageSize = 20): Promise<PaginatedUsers> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaginatedUsers>>("/api/users", {
    params: { page, pageSize },
  });
  return unwrap(response.data);
}

/** POST /api/users — creates a user (Admin only). */
export async function createUser(input: CreateUserInput): Promise<ManagedUser> {
  const response = await httpClient.post<ApiSuccessEnvelope<ManagedUser>>("/api/users", input);
  return unwrap(response.data);
}

/** PUT /api/users/:id — updates a user's name and/or role (Admin only). */
export async function updateUser(id: string, input: UpdateUserInput): Promise<ManagedUser> {
  const response = await httpClient.put<ApiSuccessEnvelope<ManagedUser>>(`/api/users/${id}`, input);
  return unwrap(response.data);
}

/** PUT /api/users/:id/password — resets a user's password (Admin only). */
export async function changeUserPassword(id: string, password: string): Promise<ManagedUser> {
  const response = await httpClient.put<ApiSuccessEnvelope<ManagedUser>>(
    `/api/users/${id}/password`,
    { password }
  );
  return unwrap(response.data);
}

/** PUT /api/users/:id/deactivate — activates or deactivates a user (Admin only). */
export async function setUserActiveState(id: string, isActive: boolean): Promise<ManagedUser> {
  const response = await httpClient.put<ApiSuccessEnvelope<ManagedUser>>(
    `/api/users/${id}/deactivate`,
    { isActive }
  );
  return unwrap(response.data);
}

// ─── Phase 3: plans, subscribers, and service accounts ────────────────────────
// Same rule as above: this is the only place the renderer performs HTTP.

export interface Plan {
  id: string;
  name: string;
  serviceType: ServiceType;
  speedMbps: number | null;
  cablePackageDescription: string | null;
  monthlyRateCentavos: number;
  reconnectionFeeCentavos: number;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
}

export interface CreatePlanInput {
  name: string;
  serviceType: ServiceType;
  speedMbps?: number;
  cablePackageDescription?: string;
  monthlyRateCentavos: number;
  reconnectionFeeCentavos?: number;
}

/** Only descriptive fields are updatable; a price change creates a new plan. */
export interface UpdatePlanInput {
  name?: string;
  speedMbps?: number | null;
  cablePackageDescription?: string | null;
}

export interface ServiceAccount {
  id: string;
  serviceAccountNumber: string;
  subscriberId: string;
  planId: string;
  planName: string;
  serviceType: ServiceType;
  monthlyRateCentavos: number;
  status: ServiceAccountStatus;
  activationDate: string | null;
  suspensionDate: string | null;
  terminationDate: string | null;
  assignedCollectorId: string | null;
  consecutiveOverdueMonths: number;
  /** Populated from the ledger in Phase 6; null until then. */
  balanceCentavos: null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceStatusHistoryEntry {
  id: string;
  previousStatus: ServiceAccountStatus;
  newStatus: ServiceAccountStatus;
  reason: string | null;
  changedBy: string;
  changedAt: string;
}

export interface ServiceAccountDetail extends ServiceAccount {
  statusHistory: ServiceStatusHistoryEntry[];
}

export interface Subscriber {
  id: string;
  accountNumber: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  primaryPhone: string;
  secondaryPhone: string | null;
  emailAddress: string | null;
  serviceAddress: string;
  serviceBarangay: string;
  serviceMunicipality: string;
  serviceProvince: string;
  internalNotes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string | null;
  serviceAccounts: ServiceAccount[];
}

export interface PaginatedSubscribers {
  items: Subscriber[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreateSubscriberInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  primaryPhone: string;
  secondaryPhone?: string;
  emailAddress?: string;
  serviceAddress: string;
  serviceBarangay: string;
  serviceMunicipality: string;
  serviceProvince: string;
  internalNotes?: string;
  /** The first service account. The Add Subscriber form always supplies one. */
  serviceAccount?: {
    planId: string;
    activationDate?: string;
    assignedCollectorId?: string;
  };
}

export interface UpdateSubscriberInput {
  firstName?: string;
  lastName?: string;
  middleName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  emailAddress?: string;
  serviceAddress?: string;
  serviceBarangay?: string;
  serviceMunicipality?: string;
  serviceProvince?: string;
  internalNotes?: string;
}

export interface StatementOfAccount {
  subscriber: Subscriber;
  generatedAt: string;
  serviceAccounts: ServiceAccount[];
  /** Computed from the ledger in Phase 6; null until then. */
  totalOutstandingCentavos: null;
}

export interface ReconnectionFeeEntry {
  serviceAccountId: string;
  planId: string;
  amountCentavos: number;
  description: string;
}

export interface ReconnectServiceAccountResult {
  serviceAccount: ServiceAccount;
  reconnectionFeeEntry: ReconnectionFeeEntry;
  /** The reconnection fee invoice raised on reconnect, or null when the plan has no fee. */
  reconnectionFeeInvoice: { invoice: InvoiceDetail; amountCentavos: number } | null;
}

export interface PlanChangeResult {
  serviceAccount: ServiceAccount;
  previousPlanId: string;
  previousMonthlyRateCentavos: number;
  newMonthlyRateCentavos: number;
}

export interface ListSubscriberFilters {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: ServiceAccountStatus;
  municipality?: string;
}

/** GET /api/plans — active plans, optionally filtered by service type. */
export async function listPlans(options: {
  serviceType?: ServiceType;
  includeInactive?: boolean;
} = {}): Promise<Plan[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<{ items: Plan[] }>>("/api/plans", {
    params: {
      serviceType: options.serviceType,
      includeInactive: options.includeInactive === true ? "true" : undefined,
    },
  });
  return unwrap(response.data).items;
}

/** POST /api/plans — creates a plan (Admin only in the current permission matrix). */
export async function createPlan(input: CreatePlanInput): Promise<Plan> {
  const response = await httpClient.post<ApiSuccessEnvelope<Plan>>("/api/plans", input);
  return unwrap(response.data);
}

/** GET /api/plans/:id — a single plan. */
export async function getPlan(id: string): Promise<Plan> {
  const response = await httpClient.get<ApiSuccessEnvelope<Plan>>(`/api/plans/${id}`);
  return unwrap(response.data);
}

/** PUT /api/plans/:id — updates descriptive fields only. */
export async function updatePlan(id: string, input: UpdatePlanInput): Promise<Plan> {
  const response = await httpClient.put<ApiSuccessEnvelope<Plan>>(`/api/plans/${id}`, input);
  return unwrap(response.data);
}

/** PUT /api/plans/:id/retire — deactivates a plan so it takes no new signups. */
export async function retirePlan(id: string): Promise<Plan> {
  const response = await httpClient.put<ApiSuccessEnvelope<Plan>>(`/api/plans/${id}/retire`);
  return unwrap(response.data);
}

/** GET /api/subscribers — paginated, searchable list. */
export async function listSubscribers(
  filters: ListSubscriberFilters = {}
): Promise<PaginatedSubscribers> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaginatedSubscribers>>(
    "/api/subscribers",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/subscribers/search — search by name, account number, or phone. */
export async function searchSubscribers(query: string): Promise<PaginatedSubscribers> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaginatedSubscribers>>(
    "/api/subscribers/search",
    { params: { q: query } }
  );
  return unwrap(response.data);
}

/** GET /api/subscribers/:id — a subscriber with all their service accounts. */
export async function getSubscriber(id: string): Promise<Subscriber> {
  const response = await httpClient.get<ApiSuccessEnvelope<Subscriber>>(`/api/subscribers/${id}`);
  return unwrap(response.data);
}

/** POST /api/subscribers — creates a subscriber, with a first service account when supplied. */
export async function createSubscriber(input: CreateSubscriberInput): Promise<Subscriber> {
  const response = await httpClient.post<ApiSuccessEnvelope<Subscriber>>(
    "/api/subscribers",
    input
  );
  return unwrap(response.data);
}

/** PUT /api/subscribers/:id — updates contact and address details. */
export async function updateSubscriber(
  id: string,
  input: UpdateSubscriberInput
): Promise<Subscriber> {
  const response = await httpClient.put<ApiSuccessEnvelope<Subscriber>>(
    `/api/subscribers/${id}`,
    input
  );
  return unwrap(response.data);
}

/** GET /api/subscribers/:id/statement — statement of account for all services. */
export async function getSubscriberStatement(id: string): Promise<StatementOfAccount> {
  const response = await httpClient.get<ApiSuccessEnvelope<StatementOfAccount>>(
    `/api/subscribers/${id}/statement`
  );
  return unwrap(response.data);
}

/** GET /api/service-accounts/:id — the account, its plan, and its status history. */
export async function getServiceAccount(id: string): Promise<ServiceAccountDetail> {
  const response = await httpClient.get<ApiSuccessEnvelope<ServiceAccountDetail>>(
    `/api/service-accounts/${id}`
  );
  return unwrap(response.data);
}

/** POST /api/subscribers/:id/service-accounts — adds another service to a subscriber. */
export async function addServiceAccount(
  subscriberId: string,
  input: { planId: string; activationDate?: string; assignedCollectorId?: string }
): Promise<ServiceAccount> {
  const response = await httpClient.post<ApiSuccessEnvelope<ServiceAccount>>(
    `/api/subscribers/${subscriberId}/service-accounts`,
    input
  );
  return unwrap(response.data);
}

/** PUT /api/service-accounts/:id/suspend — cuts off service. A reason is required. */
export async function suspendServiceAccount(
  id: string,
  reason: string
): Promise<ServiceAccount> {
  const response = await httpClient.put<ApiSuccessEnvelope<ServiceAccount>>(
    `/api/service-accounts/${id}/suspend`,
    { reason }
  );
  return unwrap(response.data);
}

/** PUT /api/service-accounts/:id/reconnect — restores service and reports the fee. */
export async function reconnectServiceAccount(
  id: string,
  reason?: string
): Promise<ReconnectServiceAccountResult> {
  const response = await httpClient.put<ApiSuccessEnvelope<ReconnectServiceAccountResult>>(
    `/api/service-accounts/${id}/reconnect`,
    { reason }
  );
  return unwrap(response.data);
}

/** PUT /api/service-accounts/:id/terminate — permanently ends service. */
export async function terminateServiceAccount(
  id: string,
  reason: string
): Promise<ServiceAccount> {
  const response = await httpClient.put<ApiSuccessEnvelope<ServiceAccount>>(
    `/api/service-accounts/${id}/terminate`,
    { reason }
  );
  return unwrap(response.data);
}

/** PUT /api/service-accounts/:id/plan — moves the account onto another plan. */
export async function changeServiceAccountPlan(
  id: string,
  planId: string
): Promise<PlanChangeResult> {
  const response = await httpClient.put<ApiSuccessEnvelope<PlanChangeResult>>(
    `/api/service-accounts/${id}/plan`,
    { planId }
  );
  return unwrap(response.data);
}

/** PUT /api/service-accounts/:id/collector — assigns or clears the field collector. */
export async function assignCollector(
  id: string,
  assignedCollectorId: string | null
): Promise<ServiceAccount> {
  const response = await httpClient.put<ApiSuccessEnvelope<ServiceAccount>>(
    `/api/service-accounts/${id}/collector`,
    { assignedCollectorId }
  );
  return unwrap(response.data);
}

// ─── Phase 4: billing and invoices ────────────────────────────────────────────
// Same rule as above: this is the only place the renderer performs HTTP.

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  billingPeriodYear: number | null;
  billingPeriodMonth: number | null;
  invoiceDate: string;
  dueDate: string;
  subtotalCentavos: number;
  lateFeesCentavos: number;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  notes: string | null;
  voidedByTransactionId: string | null;
  createdAt: string;
  postedAt: string | null;
  voidedAt: string | null;
}

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitAmountCentavos: number;
  totalAmountCentavos: number;
}

export interface InvoiceDetail extends InvoiceSummary {
  lineItems: InvoiceLineItem[];
}

export interface ListInvoiceFilters {
  status?: InvoiceStatus;
  year?: number;
  month?: number;
  subscriberId?: string;
}

export interface BillingPreview {
  billingPeriodYear: number;
  billingPeriodMonth: number;
  accountsToBill: number;
  accountsAlreadyBilled: number;
  totalAmountCentavos: number;
}

export interface BillingRunResult {
  billingPeriodYear: number;
  billingPeriodMonth: number;
  totalServiceAccountsProcessed: number;
  totalInvoicesGenerated: number;
  totalInvoicesSkipped: number;
  totalAmountBilledCentavos: number;
}

export interface BillingRunRecord {
  id: string;
  billingPeriodYear: number;
  billingPeriodMonth: number;
  totalServiceAccountsProcessed: number;
  totalInvoicesGenerated: number;
  totalInvoicesSkipped: number;
  totalAmountBilledCentavos: number;
  status: string;
  errorDetails: string | null;
  ranAt: string;
  ranBy: string;
}

/** GET /api/billing/run-preview — a dry run of the monthly billing job. */
export async function previewMonthlyBilling(year: number, month: number): Promise<BillingPreview> {
  const response = await httpClient.get<ApiSuccessEnvelope<BillingPreview>>(
    "/api/billing/run-preview",
    { params: { year, month } }
  );
  return unwrap(response.data);
}

/** POST /api/billing/run — generates draft invoices for a period. */
export async function runMonthlyBilling(year: number, month: number): Promise<BillingRunResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<BillingRunResult>>("/api/billing/run", {
    year,
    month,
  });
  return unwrap(response.data);
}

/** POST /api/billing/post-all-draft — posts every draft invoice for a period. */
export async function postAllDraftInvoices(
  year: number,
  month: number
): Promise<{ posted: number }> {
  const response = await httpClient.post<ApiSuccessEnvelope<{ posted: number }>>(
    "/api/billing/post-all-draft",
    { year, month }
  );
  return unwrap(response.data);
}

/** GET /api/billing/runs — the billing run history, newest first. */
export async function listBillingRuns(): Promise<BillingRunRecord[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<{ items: BillingRunRecord[] }>>(
    "/api/billing/runs"
  );
  return unwrap(response.data).items;
}

/** POST /api/billing/apply-late-fees — charges a late fee to overdue invoices. */
export async function applyLateFees(lateFeeCentavos?: number): Promise<{
  invoicesCharged: number;
  lateFeeCentavos: number;
}> {
  const response = await httpClient.post<
    ApiSuccessEnvelope<{ invoicesCharged: number; lateFeeCentavos: number }>
  >("/api/billing/apply-late-fees", { lateFeeCentavos });
  return unwrap(response.data);
}

/** GET /api/invoices — invoices filtered by status, period, or subscriber. */
export async function listInvoices(filters: ListInvoiceFilters = {}): Promise<InvoiceSummary[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<{ items: InvoiceSummary[] }>>(
    "/api/invoices",
    { params: filters }
  );
  return unwrap(response.data).items;
}

/** GET /api/invoices/:id — one invoice with its line items. */
export async function getInvoice(id: string): Promise<InvoiceDetail> {
  const response = await httpClient.get<ApiSuccessEnvelope<InvoiceDetail>>(`/api/invoices/${id}`);
  return unwrap(response.data);
}

/** POST /api/invoices/reconnection-fee — generates a reconnection fee invoice. */
export async function createReconnectionFeeInvoice(input: {
  serviceAccountId: string;
  reason?: string;
}): Promise<{ invoice: InvoiceDetail; amountCentavos: number }> {
  const response = await httpClient.post<
    ApiSuccessEnvelope<{ invoice: InvoiceDetail; amountCentavos: number }>
  >("/api/invoices/reconnection-fee", input);
  return unwrap(response.data);
}

/** POST /api/invoices/:id/post — posts one draft invoice, creating a ledger debit. */
export async function postInvoice(id: string): Promise<InvoiceDetail> {
  const response = await httpClient.post<ApiSuccessEnvelope<InvoiceDetail>>(
    `/api/invoices/${id}/post`
  );
  return unwrap(response.data);
}

/** POST /api/invoices/:id/void — voids an invoice, creating a ledger credit. */
export async function voidInvoice(id: string, reason: string): Promise<InvoiceDetail> {
  const response = await httpClient.post<ApiSuccessEnvelope<InvoiceDetail>>(
    `/api/invoices/${id}/void`,
    { reason }
  );
  return unwrap(response.data);
}

// ─── Phase 5: payments, receipts, and reversals ───────────────────────────────
// Same rule as above: this is the only place the renderer performs HTTP.

export interface PaymentSummary {
  id: string;
  receiptNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  amountCentavos: number;
  allocatedCentavos: number;
  advanceCreditCentavos: number;
  paymentDate: string;
  notes: string | null;
  gcashReferenceNumber: string | null;
  postedAt: string;
  postedById: string;
  postedByName: string;
  reversedAt: string | null;
  reversedById: string | null;
}

export interface PaymentAllocationSummary {
  invoiceId: string;
  invoiceNumber: string;
  allocatedAmountCentavos: number;
}

export interface PaymentDetail extends PaymentSummary {
  allocations: PaymentAllocationSummary[];
  gcash: {
    referenceNumber: string;
    senderGcashNumber: string | null;
    senderName: string | null;
    screenshotFilePath: string | null;
    verifiedAt: string | null;
  } | null;
}

export interface OutstandingInvoiceSummary {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: string;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
}

export interface ServiceAccountPaymentSummary {
  serviceAccountId: string;
  outstandingInvoices: OutstandingInvoiceSummary[];
  outstandingTotalCentavos: number;
  creditBalanceCentavos: number;
}

export interface PostPaymentInput {
  serviceAccountId: string;
  paymentMethod: PostablePaymentMethod;
  amountCentavos: number;
  paymentDate: string;
  notes?: string;
  gcash?: {
    referenceNumber: string;
    senderGcashNumber?: string;
    senderName?: string;
    screenshotFilePath?: string;
  };
}

export interface PostPaymentResult {
  payment: PaymentSummary;
  allocations: PaymentAllocationSummary[];
  allocatedCentavos: number;
  advanceCreditCentavos: number;
}

export interface ReversePaymentResult {
  paymentId: string;
  reversalReceiptNumber: string;
  reversedAt: string;
}

export interface ListPaymentFilters {
  serviceAccountId?: string;
  method?: PaymentMethod;
  status?: PaymentStatus;
  dateFrom?: string;
  dateTo?: string;
}

/** GET /api/payments — the payment history, newest first. */
export async function listPayments(
  filters: ListPaymentFilters = {}
): Promise<PaymentSummary[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<{ items: PaymentSummary[] }>>(
    "/api/payments",
    { params: filters }
  );
  return unwrap(response.data).items;
}

/** GET /api/payments/:id — one payment with its allocations. */
export async function getPayment(id: string): Promise<PaymentDetail> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaymentDetail>>(`/api/payments/${id}`);
  return unwrap(response.data);
}

/** GET /api/payments/receipt/:receiptNumber — lookup by receipt number. */
export async function getPaymentByReceiptNumber(receiptNumber: string): Promise<PaymentDetail> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaymentDetail>>(
    `/api/payments/receipt/${encodeURIComponent(receiptNumber)}`
  );
  return unwrap(response.data);
}

/** POST /api/payments — posts a Cash or GCash payment. */
export async function postPayment(input: PostPaymentInput): Promise<PostPaymentResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<PostPaymentResult>>(
    "/api/payments",
    input
  );
  return unwrap(response.data);
}

/** POST /api/payments/:id/reverse — reverses a payment (Admin only). */
export async function reversePayment(id: string, reason: string): Promise<ReversePaymentResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<ReversePaymentResult>>(
    `/api/payments/${id}/reverse`,
    { reason }
  );
  return unwrap(response.data);
}

/** GET /api/service-accounts/:id/payments — every payment for one account. */
export async function listServiceAccountPayments(
  serviceAccountId: string
): Promise<PaymentSummary[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<{ items: PaymentSummary[] }>>(
    `/api/service-accounts/${serviceAccountId}/payments`
  );
  return unwrap(response.data).items;
}

/** GET /api/service-accounts/:id/payment-summary — what a cashier sees before posting. */
export async function getServiceAccountPaymentSummary(
  serviceAccountId: string
): Promise<ServiceAccountPaymentSummary> {
  const response = await httpClient.get<ApiSuccessEnvelope<ServiceAccountPaymentSummary>>(
    `/api/service-accounts/${serviceAccountId}/payment-summary`
  );
  return unwrap(response.data);
}

/** POST /api/payments/gcash/upload-screenshot — stores a GCash proof screenshot. */
export async function uploadGcashScreenshot(input: {
  fileName: string;
  contentType: string;
  dataBase64: string;
}): Promise<{ filePath: string; sizeBytes: number }> {
  const response = await httpClient.post<ApiSuccessEnvelope<{ filePath: string; sizeBytes: number }>>(
    "/api/payments/gcash/upload-screenshot",
    input
  );
  return unwrap(response.data);
}
