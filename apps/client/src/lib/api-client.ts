// The ONLY place in the renderer that performs HTTP.
//
// The sandboxed renderer has no database driver and no raw sockets: every piece
// of data the UI shows must arrive through a function in this file.
// Domain endpoints answer with the { success, data } envelope; helpers below
// unwrap it so callers work with the payload directly.

import axios, { AxiosError } from "axios";

import type {
  AnyReportType,
  CollectedMethod,
  CollectionResult,
  CollectorBatchStatus,
  PaginatedAuditLogs,
  InvoiceStatus,
  InvoiceType,
  LedgerEntryType,
  ManualLedgerEntryType,
  PaymentMethod,
  PaymentStatus,
  PostablePaymentMethod,
  ServiceAccountStatus,
  ServiceType,
  SystemSetting,
  UserRole,
} from "@bcis/shared";
import { API_BASE_URL, HTTP_TIMEOUT_MS } from "./constants";
import { useAuthStore } from "../stores/auth.store";

const httpClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: HTTP_TIMEOUT_MS,
  headers: { "Content-Type": "application/json" },
});

// The API server this session is talking to. It starts as the build-time default
// and is replaced once by the run-time config.json value (see main.tsx), so every
// later request — including the interceptors below — uses the chosen server.
let apiBaseUrl = API_BASE_URL;

/** The API server currently in use, for display in the UI. */
export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

/** Points every subsequent request at the API server chosen for this installation. */
export function configureApiBaseUrl(baseUrl: string): void {
  apiBaseUrl = baseUrl;
  httpClient.defaults.baseURL = baseUrl;
}

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
  /** The balance computed from the ledger in Phase 6; negative means an advance credit. */
  balanceCentavos: number | null;
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
  /** The sum of every positive account balance, computed from the ledger. */
  totalOutstandingCentavos: number;
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
export async function listPlans(
  options: {
    serviceType?: ServiceType;
    includeInactive?: boolean;
  } = {}
): Promise<Plan[]> {
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
  const response = await httpClient.post<ApiSuccessEnvelope<Subscriber>>("/api/subscribers", input);
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
export async function suspendServiceAccount(id: string, reason: string): Promise<ServiceAccount> {
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
export async function terminateServiceAccount(id: string, reason: string): Promise<ServiceAccount> {
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
  /** 1-based page number. The server defaults to the first page. */
  page?: number;
  /** Rows per page. The server caps this at 200 and defaults to 50. */
  pageSize?: number;
}

/**
 * One page of invoices (S8-1). `total` counts everything the filters matched, so
 * the caller can render "page 2 of 7" and request later pages.
 */
export interface InvoicePage {
  items: InvoiceSummary[];
  page: number;
  pageSize: number;
  total: number;
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
  const response =
    await httpClient.get<ApiSuccessEnvelope<{ items: BillingRunRecord[] }>>("/api/billing/runs");
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

/** GET /api/invoices — one page of invoices filtered by status, period, or subscriber. */
export async function listInvoices(filters: ListInvoiceFilters = {}): Promise<InvoicePage> {
  const response = await httpClient.get<ApiSuccessEnvelope<InvoicePage>>("/api/invoices", {
    params: filters,
  });
  return unwrap(response.data);
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
  /** 1-based page number. The server defaults to the first page. */
  page?: number;
  /** Rows per page. The server caps this at 200 and defaults to 50. */
  pageSize?: number;
}

/**
 * One page of payments (S8-1). `total` counts everything the filters matched, so
 * the caller can render "page 2 of 7" and request later pages.
 */
export interface PaymentPage {
  items: PaymentSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** GET /api/payments — one page of the payment history, newest first. */
export async function listPayments(filters: ListPaymentFilters = {}): Promise<PaymentPage> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaymentPage>>("/api/payments", {
    params: filters,
  });
  return unwrap(response.data);
}

/**
 * GET /api/service-accounts/:id/payments — one page of payments for one account.
 *
 * The route pages on the server (S8-1) but takes no page arguments yet, so this
 * returns the first page's items. Callers that need more must page /api/payments
 * with a `serviceAccountId` filter instead.
 */
export async function listServiceAccountPayments(
  serviceAccountId: string
): Promise<PaymentSummary[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaymentPage>>(
    `/api/service-accounts/${serviceAccountId}/payments`
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
  const response = await httpClient.post<
    ApiSuccessEnvelope<{ filePath: string; sizeBytes: number }>
  >("/api/payments/gcash/upload-screenshot", input);
  return unwrap(response.data);
}

// ─── Phase 6: ledger, balance, and statement of account ──────────────────────
// Same rule as above: this is the only place the renderer performs HTTP.

export interface LedgerEntrySummary {
  id: string;
  sequenceNumber: number;
  entryDate: string;
  entryType: LedgerEntryType;
  direction: "debit" | "credit";
  amountCentavos: number;
  debitCentavos: number;
  creditCentavos: number;
  runningBalanceCentavos: number;
  description: string;
  invoiceId: string | null;
  paymentId: string | null;
  referenceNumber: string;
  createdBy: string;
}

export interface LedgerHeader {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  planName: string;
  serviceType: ServiceType;
  monthlyRateCentavos: number;
  status: ServiceAccountStatus;
  balanceCentavos: number;
  entryCount: number;
  lastEntryAt: string | null;
}

export interface ServiceAccountLedger {
  header: LedgerHeader;
  items: LedgerEntrySummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ServiceAccountBalance {
  serviceAccountId: string;
  balanceCentavos: number;
  entryCount: number;
  lastEntryAt: string | null;
}

export interface StatementOfAccountLine {
  id: string;
  sequenceNumber: number;
  date: string;
  description: string;
  debitCentavos: number;
  creditCentavos: number;
  balanceCentavos: number;
  referenceNumber: string;
  entryType: LedgerEntryType;
}

export interface ServiceAccountStatement {
  serviceAccount: {
    id: string;
    serviceAccountNumber: string;
    planName: string;
    serviceType: ServiceType;
    monthlyRateCentavos: number;
    status: ServiceAccountStatus;
  };
  subscriber: {
    id: string;
    accountNumber: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
    serviceAddress: string;
    serviceBarangay: string;
    serviceMunicipality: string;
    serviceProvince: string;
  };
  generatedAt: string;
  periodFrom: string | null;
  periodTo: string | null;
  asOfDate: string;
  lines: StatementOfAccountLine[];
  openingBalanceCentavos: number;
  closingBalanceCentavos: number;
  totalDebitsCentavos: number;
  totalCreditsCentavos: number;
}

export interface LedgerIntegrityResult {
  isValid: boolean;
  failure: "duplicate_sequence_number" | "sequence_gap" | "broken_running_balance" | null;
  discrepancyCentavos: number;
  duplicateSequenceNumber: number | null;
  missingSequenceNumber: number | null;
  entryCount: number;
  lastComputedBalanceCentavos: number;
  lastStoredBalanceCentavos: number;
}

export interface ManualLedgerEntryInput {
  serviceAccountId: string;
  entryType: ManualLedgerEntryType;
  amountCentavos: number;
  reason: string;
}

export interface ManualLedgerEntryResult {
  entryId: string;
  balanceCentavos: number;
}

/** GET /api/service-accounts/:id/ledger — the header and a page of ledger entries. */
export async function getServiceAccountLedger(
  serviceAccountId: string,
  filters: { fromDate?: string; toDate?: string; page?: number; pageSize?: number } = {}
): Promise<ServiceAccountLedger> {
  const response = await httpClient.get<ApiSuccessEnvelope<ServiceAccountLedger>>(
    `/api/service-accounts/${serviceAccountId}/ledger`,
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/service-accounts/:id/balance — the current balance only. */
export async function getServiceAccountBalanceApi(
  serviceAccountId: string
): Promise<ServiceAccountBalance> {
  const response = await httpClient.get<ApiSuccessEnvelope<ServiceAccountBalance>>(
    `/api/service-accounts/${serviceAccountId}/balance`
  );
  return unwrap(response.data);
}

/** GET /api/service-accounts/:id/statement — the full statement of account. */
export async function getServiceAccountStatement(
  serviceAccountId: string,
  filters: { fromDate?: string; toDate?: string } = {}
): Promise<ServiceAccountStatement> {
  const response = await httpClient.get<ApiSuccessEnvelope<ServiceAccountStatement>>(
    `/api/service-accounts/${serviceAccountId}/statement`,
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/ledger/verify/:serviceAccountId — integrity check (Admin only). */
export async function verifyLedgerIntegrity(
  serviceAccountId: string
): Promise<LedgerIntegrityResult> {
  const response = await httpClient.get<ApiSuccessEnvelope<LedgerIntegrityResult>>(
    `/api/ledger/verify/${serviceAccountId}`
  );
  return unwrap(response.data);
}

/** POST /api/ledger/manual-entry — a manual debit or credit (Admin only). */
export async function postManualLedgerEntry(
  input: ManualLedgerEntryInput
): Promise<ManualLedgerEntryResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<ManualLedgerEntryResult>>(
    "/api/ledger/manual-entry",
    input
  );
  return unwrap(response.data);
}

// ─── Phase 7: field collection and receivables ────────────────────────────────
// Same rule as above: this is the only place the renderer performs HTTP.
//
// Every monetary value here is an integer number of centavos. The renderer never
// does money arithmetic in floating point; it only formats the integers.

export interface AssignableCollector {
  id: string;
  fullName: string;
  isActive: boolean;
}

export interface CollectorBatchSummary {
  id: string;
  batchNumber: string;
  collectorId: string;
  collectorName: string;
  status: CollectorBatchStatus;
  collectionDate: string;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number | null;
  varianceCentavos: number | null;
  varianceNotes: string | null;
  assignmentCount: number;
  collectedCount: number;
  createdAt: string;
  submittedAt: string | null;
  reconciledAt: string | null;
  closedAt: string | null;
}

/**
 * The batch money split by method (S4-4).
 *
 * By construction `cash + nonCash = collectedTotal` and `collectedTotal +
 * uncollected = expectedReceivable`. The split is what tells an operator that a
 * batch brought back more GCash than cash before they reconcile it.
 */
export interface BatchMethodSummary {
  expectedReceivableCentavos: number;
  cashCollectedCentavos: number;
  gcashCollectedCentavos: number;
  nonCashCollectedCentavos: number;
  collectedTotalCentavos: number;
  uncollectedCentavos: number;
}

export interface BatchAssignmentSummary {
  id: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  planName: string;
  outstandingBalanceCentavos: number;
  collectionResult: CollectionResult | null;
  collectedAmountCentavos: number | null;
  collectedMethod: CollectedMethod | null;
  paymentId: string | null;
  collectorNotes: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface CollectorBatchDetail extends CollectorBatchSummary {
  assignments: BatchAssignmentSummary[];
  collectedTotalCentavos: number;
  outstandingTotalCentavos: number;
  methodSummary: BatchMethodSummary;
}

export interface CollectorBatchList {
  items: CollectorBatchSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListCollectorBatchFilters {
  collectorId?: string;
  status?: CollectorBatchStatus;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateCollectorBatchInput {
  collectorId: string;
  collectionDate: string;
  serviceAccountIds: string[];
}

export interface RecordCollectionInput {
  result: CollectionResult;
  collectedAmountCentavos?: number;
  collectedMethod?: CollectedMethod;
  collectorNotes?: string;
  gcash?: { referenceNumber: string; senderName?: string; senderGcashNumber?: string };
}

export interface RecordCollectionResult {
  batchId: string;
  serviceAccountId: string;
  expectedRemittanceCentavos: number;
  paymentId: string | null;
}

/** POST /api/collector-batches/:id/submit — declares the field run finished. */
export interface SubmitBatchResult {
  batchId: string;
  status: CollectorBatchStatus;
  submittedAt: string;
  assignmentCount: number;
  expectedRemittanceCentavos: number;
}

/** POST /api/collector-batches/:id/remit — the cash hand-in (S4-2). */
export interface RecordBatchRemittanceInput {
  /** The total handed in. Negative only when correcting an earlier remittance. */
  amountCentavos: number;
  cashAmountCentavos?: number;
  gcashAmountCentavos?: number;
  notes?: string;
}

export interface RemitBatchResult {
  batchId: string;
  remittanceId: string;
  status: CollectorBatchStatus;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number;
  varianceCentavos: number;
  hasVariance: boolean;
  remittanceCount: number;
}

/** One row of a batch's remittance history. */
export interface BatchRemittanceSummary {
  id: string;
  batchId: string;
  amountCentavos: number;
  cashAmountCentavos: number;
  gcashAmountCentavos: number;
  remittedById: string;
  remittedByName: string;
  remittedAt: string;
  notes: string | null;
}

/** POST /api/collector-batches/:id/close — the separate final sign-off (S4-1). */
export interface CloseBatchResult {
  batchId: string;
  batchNumber: string;
  status: CollectorBatchStatus;
  closedAt: string;
  varianceCentavos: number;
  reconciledAt: string | null;
}

/** One line of the printable route sheet (S4-3). */
export interface BatchRouteSheetRow {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  address: string;
  currentBillCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
  collectorName: string;
  areaName: string;
}

export interface RouteSheetTotals {
  accountCount: number;
  currentBillCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
}

export interface BatchRouteSheet {
  batchId: string;
  batchNumber: string;
  collectorName: string;
  collectionDate: string;
  areaName: string | null;
  rows: BatchRouteSheetRow[];
  totals: RouteSheetTotals;
}

export interface ReconcileBatchResult {
  batchId: string;
  varianceCentavos: number;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number;
  ledgerCreditTotalCentavos: number;
  ledgerReconciles: boolean;
}

export interface ArAgingEntry {
  subscriberId: string;
  subscriberName: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  planName: string;
  currentCentavos: number;
  bucket_1_30_centavos: number;
  bucket_31_60_centavos: number;
  bucket_61_90_centavos: number;
  over_90_centavos: number;
  totalOutstandingCentavos: number;
}

export interface ArAgingTotals {
  current: number;
  bucket_1_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  over_90: number;
  grandTotal: number;
}

export interface ArAgingReport {
  asOfDate: string;
  entries: ArAgingEntry[];
  totals: ArAgingTotals;
}

/** A bucket in the overdue summary, e.g. "3_months_or_more". */
export type OverdueSummaryBucketKey = "1_month" | "2_months" | "3_months_or_more";

export interface OverdueSummaryBucket {
  bucket: OverdueSummaryBucketKey;
  accountCount: number;
  totalCentavos: number;
}

export interface OverdueAccount {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  planName: string;
  consecutiveOverdueMonths: number;
  totalOverdueCentavos: number;
  collectorId: string | null;
  collectorName: string | null;
  lastPaymentDate: string | null;
  /** S4-5: the collection area the account sits in. */
  areaName: string | null;
  /** S4-5: the invoice number of the oldest unpaid invoice. */
  oldestUnpaidInvoiceNumber: string | null;
  /** S4-5: the due date of that oldest invoice. */
  oldestUnpaidDueDate: string | null;
}

export interface OverdueAccountsResult {
  items: OverdueAccount[];
  totalOverdueCentavos: number;
}

export interface OverdueSummaryResult {
  accountCount: number;
  totalOverdueCentavos: number;
  buckets: OverdueSummaryBucket[];
}

export interface SuspendOverdueResult {
  suspended: string[];
  failed: { serviceAccountId: string; message: string }[];
}

/** GET /api/collector-batches/collectors — the active collectors a batch can be for. */
export async function listAssignableCollectors(): Promise<AssignableCollector[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<{ items: AssignableCollector[] }>>(
    "/api/collector-batches/collectors"
  );
  return unwrap(response.data).items;
}

/** GET /api/collector-batches — the batch list, scoped to the caller on the server. */
export async function listCollectorBatches(
  filters: ListCollectorBatchFilters = {}
): Promise<CollectorBatchList> {
  const response = await httpClient.get<ApiSuccessEnvelope<CollectorBatchList>>(
    "/api/collector-batches",
    { params: filters }
  );
  return unwrap(response.data);
}

/** POST /api/collector-batches — creates a batch with its first service accounts. */
export async function createCollectorBatch(
  input: CreateCollectorBatchInput
): Promise<CollectorBatchDetail> {
  const response = await httpClient.post<ApiSuccessEnvelope<CollectorBatchDetail>>(
    "/api/collector-batches",
    input
  );
  return unwrap(response.data);
}

/** GET /api/collector-batches/:id — one batch with its assignments and totals. */
export async function getCollectorBatch(batchId: string): Promise<CollectorBatchDetail> {
  const response = await httpClient.get<ApiSuccessEnvelope<CollectorBatchDetail>>(
    `/api/collector-batches/${batchId}`
  );
  return unwrap(response.data);
}

/** POST /api/collector-batches/:id/assignments — adds accounts to an open batch. */
export async function addBatchAssignments(
  batchId: string,
  serviceAccountIds: string[]
): Promise<CollectorBatchDetail> {
  const response = await httpClient.post<ApiSuccessEnvelope<CollectorBatchDetail>>(
    `/api/collector-batches/${batchId}/assignments`,
    { serviceAccountIds }
  );
  return unwrap(response.data);
}

/** PUT /api/collector-batches/:id/assignments/:serviceAccountId — records a visit. */
export async function recordCollection(
  batchId: string,
  serviceAccountId: string,
  input: RecordCollectionInput
): Promise<RecordCollectionResult> {
  const response = await httpClient.put<ApiSuccessEnvelope<RecordCollectionResult>>(
    `/api/collector-batches/${batchId}/assignments/${serviceAccountId}`,
    input
  );
  return unwrap(response.data);
}

/** PUT .../assignments/:serviceAccountId/void — voids a collection. */
export async function voidCollection(
  batchId: string,
  serviceAccountId: string,
  reason: string
): Promise<RecordCollectionResult> {
  const response = await httpClient.put<ApiSuccessEnvelope<RecordCollectionResult>>(
    `/api/collector-batches/${batchId}/assignments/${serviceAccountId}/void`,
    { reason }
  );
  return unwrap(response.data);
}

/**
 * POST /api/collector-batches/:id/submit — declares the field run finished.
 *
 * The body is deliberately EMPTY: submitting carries no amount and no note. The
 * cash handed in is the separate remittance step below, so declaring the run over
 * and paying the money in can never be confused (S4-2).
 */
export async function submitBatch(batchId: string): Promise<SubmitBatchResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<SubmitBatchResult>>(
    `/api/collector-batches/${batchId}/submit`,
    {}
  );
  return unwrap(response.data);
}

/**
 * POST /api/collector-batches/:id/remit — records the cash handed in (S4-2).
 *
 * A batch may be remitted more than once (instalments), and a negative amount is
 * the correcting row that sits beside the one it fixes. The result carries the
 * recomputed batch total and variance.
 */
export async function recordBatchRemittance(
  batchId: string,
  input: RecordBatchRemittanceInput
): Promise<RemitBatchResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<RemitBatchResult>>(
    `/api/collector-batches/${batchId}/remit`,
    input
  );
  return unwrap(response.data);
}

/** GET /api/collector-batches/:id/remittances — the batch's remittance history. */
export async function listBatchRemittances(
  batchId: string
): Promise<BatchRemittanceSummary[]> {
  const response = await httpClient.get<ApiSuccessEnvelope<{ items: BatchRemittanceSummary[] }>>(
    `/api/collector-batches/${batchId}/remittances`
  );
  return unwrap(response.data).items;
}

/** GET /api/collector-batches/:id/route-sheet — the printable route sheet (S4-3). */
export async function getBatchRouteSheet(batchId: string): Promise<BatchRouteSheet> {
  const response = await httpClient.get<ApiSuccessEnvelope<BatchRouteSheet>>(
    `/api/collector-batches/${batchId}/route-sheet`
  );
  return unwrap(response.data);
}

/**
 * GET /api/collector-batches/:id/route-sheet/export — the sheet as a file (S4-3).
 *
 * The response is a file, not the JSON envelope, so it is fetched as an array
 * buffer and handed to Electron's save dialog / a download.
 */
export async function downloadBatchRouteSheet(
  batchId: string,
  format: "pdf" | "xlsx"
): Promise<{ fileName: string; bytes: ArrayBuffer }> {
  const response = await httpClient.get<ArrayBuffer>(
    `/api/collector-batches/${batchId}/route-sheet/export`,
    { params: { format }, responseType: "arraybuffer" }
  );
  return { fileName: `route-sheet-${batchId}.${format}`, bytes: response.data };
}

/** POST /api/collector-batches/:id/close — the separate final sign-off (S4-1). */
export async function closeBatch(batchId: string, notes?: string): Promise<CloseBatchResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<CloseBatchResult>>(
    `/api/collector-batches/${batchId}/close`,
    notes === undefined || notes === "" ? {} : { notes }
  );
  return unwrap(response.data);
}

/** POST /api/collector-batches/:id/reconcile — closes a submitted batch. */
export async function reconcileBatch(
  batchId: string,
  varianceNotes?: string
): Promise<ReconcileBatchResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<ReconcileBatchResult>>(
    `/api/collector-batches/${batchId}/reconcile`,
    { varianceNotes }
  );
  return unwrap(response.data);
}

/** POST /api/collector-batches/:id/cancel — abandons an open batch. */
export async function cancelCollectorBatch(
  batchId: string,
  reason?: string
): Promise<CollectorBatchSummary> {
  const response = await httpClient.post<ApiSuccessEnvelope<CollectorBatchSummary>>(
    `/api/collector-batches/${batchId}/cancel`,
    { reason }
  );
  return unwrap(response.data);
}

/**
 * GET /api/receivables/ar-aging — the AR aging report as of a calendar day.
 *
 * The report honours the shared account filters as well as the as-of day (S4-6,
 * S6-2), so the aging screen can narrow the book by collector, area, plan or
 * service type. Every supplied filter is sent; an omitted one is left off.
 */
export async function getArAging(
  asOfDate?: string,
  filters: ReportFilterParams = {}
): Promise<ArAgingReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<ArAgingReport>>(
    "/api/receivables/ar-aging",
    { params: { asOfDate, ...filters } }
  );
  return unwrap(response.data);
}

/**
 * GET /api/receivables/ar-aging/export — downloads the .xlsx workbook.
 *
 * The response is a file, not the JSON envelope, so it is fetched as an array
 * buffer. The renderer then hands the bytes to Electron's save dialog / a download.
 * The same filters the screen applied travel into the export, so a filtered screen
 * and its file agree.
 */
export async function downloadArAgingXlsx(
  asOfDate?: string,
  filters: ReportFilterParams = {}
): Promise<{ fileName: string; bytes: ArrayBuffer }> {
  const response = await httpClient.get<ArrayBuffer>("/api/receivables/ar-aging/export", {
    params: { asOfDate, format: "xlsx", ...filters },
    responseType: "arraybuffer",
  });
  const fileName = `AR-aging-${asOfDate ?? new Date().toISOString().slice(0, 10)}.xlsx`;
  return { fileName, bytes: response.data };
}

/**
 * The filters the overdue list honours (S4-5, S6-2).
 *
 * `minOverdueDays` is the delinquency-age filter: only accounts whose OLDEST
 * unpaid invoice is at least that many days past due. The account filters are the
 * same ones every report accepts, so the list can be narrowed to one collector,
 * area, plan or service type.
 */
export interface OverdueAccountFilters extends ReportFilterParams {
  /** Only accounts with no payment in the last N days (omit for any). */
  noPaymentInDays?: number;
  /** Only accounts overdue for at least this many consecutive months. */
  minConsecutiveOverdueMonths?: number;
  /** Only accounts whose oldest unpaid invoice is at least this many days past due. */
  minOverdueDays?: number;
}

/** GET /api/receivables/overdue — the overdue service accounts. */
export async function getOverdueAccounts(
  filters: OverdueAccountFilters = {}
): Promise<OverdueAccountsResult> {
  const response = await httpClient.get<ApiSuccessEnvelope<OverdueAccountsResult>>(
    "/api/receivables/overdue",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/receivables/overdue-summary — counts and totals by overdue duration. */
export async function getOverdueSummary(
  filters: OverdueAccountFilters = {}
): Promise<OverdueSummaryResult> {
  const response = await httpClient.get<ApiSuccessEnvelope<OverdueSummaryResult>>(
    "/api/receivables/overdue-summary",
    { params: filters }
  );
  return unwrap(response.data);
}

/** POST /api/receivables/overdue/suspend — suspends the selected accounts. */
export async function suspendOverdueAccounts(
  serviceAccountIds: string[],
  reason: string
): Promise<SuspendOverdueResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<SuspendOverdueResult>>(
    "/api/receivables/overdue/suspend",
    { serviceAccountIds, reason }
  );
  return unwrap(response.data);
}

/** One account a suspension run would cut off (S4-7). */
export interface SuspensionCandidate {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  /** The due date of the oldest unpaid invoice. */
  oldestDueDate: string;
  /** Whole days that oldest invoice is past due, as of the run day. */
  daysPastDue: number;
  totalOverdueCentavos: number;
}

/** GET /api/service-accounts/suspension-candidates — who WOULD be suspended. */
export interface SuspensionCandidatesResult {
  thresholdDays: number;
  asOfDate: string;
  candidates: SuspensionCandidate[];
  candidateCount: number;
  totalOverdueCentavos: number;
}

/** POST /api/service-accounts/suspension-candidates/run — performs the suspensions. */
export interface SuspensionRunResult {
  thresholdDays: number;
  asOfDate: string;
  suspended: SuspensionCandidate[];
  failed: { serviceAccountId: string; message: string }[];
}

/** The threshold override an on-demand suspension run may carry. */
export interface SuspensionRunInput {
  thresholdDays?: number;
  reason?: string;
}

/**
 * GET /api/service-accounts/suspension-candidates — the suspension PREVIEW (S4-7).
 *
 * Reads the configured threshold (or an override) and reports who qualifying
 * accounts are. Nothing is changed: this is the list an operator looks at before
 * deciding to run the suspensions.
 */
export async function getSuspensionCandidates(
  thresholdDays?: number
): Promise<SuspensionCandidatesResult> {
  const response = await httpClient.get<ApiSuccessEnvelope<SuspensionCandidatesResult>>(
    "/api/service-accounts/suspension-candidates",
    { params: { thresholdDays } }
  );
  return unwrap(response.data);
}

/**
 * POST /api/service-accounts/suspension-candidates/run — performs the suspensions.
 *
 * Explicit and separate from the preview: nothing is suspended by reading the
 * candidate list. Requires `subscribers:suspend` on the server.
 */
export async function runSuspensionCandidates(
  input: SuspensionRunInput = {}
): Promise<SuspensionRunResult> {
  const response = await httpClient.post<ApiSuccessEnvelope<SuspensionRunResult>>(
    "/api/service-accounts/suspension-candidates/run",
    input
  );
  return unwrap(response.data);
}

// ─── Phase 8: management dashboard and reports ────────────────────────────────
// Same rule as above: this is the only place the renderer performs HTTP.
//
// Reports arrive as JSON for the screen and as a file for an export. Every monetary
// value is an integer number of centavos; the renderer only formats them.

export interface DashboardKpis {
  totalActiveServiceAccounts: number;
  newServiceAccountsThisMonth: number;
  suspendedAccounts: number;
  terminatedAccounts: number;
  totalInvoicedThisMonthCentavos: number;
  totalCollectedThisMonthCentavos: number;
  collectionRatePercent: number;
  totalOutstandingArCentavos: number;
  overdueOver30DaysCentavos: number;
  overdueOver90DaysCentavos: number;
  openCollectorBatches: number;
  submittedBatchesPendingReconciliation: number;
  lastBillingRunDate: string | null;
  lastBillingRunAccountsCount: number | null;
}

export interface DailyCollectionItem {
  receiptNumber: string;
  postedAt: string;
  subscriberName: string;
  serviceAccountNumber: string;
  paymentMethod: PaymentMethod;
  amountCentavos: number;
  postedByName: string;
}

export interface PaymentTotals {
  paymentCount: number;
  cashTotalCentavos: number;
  gcashTotalCentavos: number;
  grandTotalCentavos: number;
}

export interface DailyCollectionReport {
  date: string;
  items: DailyCollectionItem[];
  totals: PaymentTotals;
}

export interface MonthlyBillingItem {
  invoiceNumber: string;
  subscriberName: string;
  serviceAccountNumber: string;
  planName: string;
  invoiceDate: string;
  dueDate: string;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  status: InvoiceStatus;
}

export interface MonthlyBillingReport {
  year: number;
  month: number;
  periodLabel: string;
  items: MonthlyBillingItem[];
  totals: {
    invoiceCount: number;
    totalInvoicedCentavos: number;
    totalPaidCentavos: number;
    totalOutstandingCentavos: number;
  };
}

export interface CollectorRemittanceLine {
  subscriberName: string;
  serviceAccountNumber: string;
  collectedAmountCentavos: number;
  collectedMethod: CollectedMethod | null;
  collectionResult: CollectionResult | null;
  isVoided: boolean;
}

export interface CollectorRemittanceReport {
  batchId: string;
  batchNumber: string;
  collectorName: string;
  collectionDate: string;
  status: CollectorBatchStatus;
  lines: CollectorRemittanceLine[];
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number | null;
  varianceCentavos: number | null;
  hasVariance: boolean;
}

export interface CollectorOutstandingGroup {
  collectorId: string | null;
  collectorName: string;
  assignedAccountCount: number;
  totalOutstandingCentavos: number;
  bucket_30_60_centavos: number;
  bucket_60_90_centavos: number;
  over_90_centavos: number;
}

export interface OutstandingByCollectorReport {
  asOfDate: string;
  groups: CollectorOutstandingGroup[];
  totals: CollectorOutstandingGroup;
}

/** The parameters an export request carries. Only the chosen report reads them. */
export interface ReportExportParams {
  date?: string;
  year?: number;
  month?: number;
  asOf?: string;
  batchId?: string;
  serviceAccountId?: string;
  fromDate?: string;
  toDate?: string;
  // The shared report filters (S6-2): the export path reads the same fields the
  // on-screen endpoint does, so a filtered screen and its export agree.
  collectorId?: string;
  areaId?: string;
  planId?: string;
  serviceType?: ServiceType;
  serviceStatus?: ServiceAccountStatus;
  performedBy?: string;
  action?: string;
  entityType?: string;
}

export interface ReportExportRequest {
  reportType: AnyReportType;
  params: ReportExportParams;
}

export interface DownloadedReport {
  fileName: string;
  bytes: ArrayBuffer;
  /**
   * The export cap in force for this file (S6-6). The server states it in a header
   * and in the document subtitle, so the client never has to guess it.
   */
  rowLimit: number | null;
  /** The number of data rows the report had, before the cap was applied. */
  totalRows: number | null;
  /** True when the cap dropped rows, so the file is a partial report. */
  isTruncated: boolean;
}

/** GET /api/dashboard/kpis — every KPI the dashboard shows. */
export async function getDashboardKpis(): Promise<DashboardKpis> {
  const response = await httpClient.get<ApiSuccessEnvelope<DashboardKpis>>("/api/dashboard/kpis");
  return unwrap(response.data);
}

/** GET /api/reports/daily-collection — everything collected on one day. */
export async function getDailyCollectionReport(date?: string): Promise<DailyCollectionReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<DailyCollectionReport>>(
    "/api/reports/daily-collection",
    { params: { date } }
  );
  return unwrap(response.data);
}

/** GET /api/reports/monthly-billing — every invoice raised for a billing period. */
export async function getMonthlyBillingReport(
  year: number,
  month: number
): Promise<MonthlyBillingReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<MonthlyBillingReport>>(
    "/api/reports/monthly-billing",
    { params: { year, month } }
  );
  return unwrap(response.data);
}

/**
 * GET /api/reports/ar-aging — the AR aging report as of a calendar day.
 *
 * The report honours the shared account filters as well as the as-of day (S6-2), so
 * the Reports Center can narrow it by collector, area, plan or service type.
 */
export async function getArAgingReport(
  asOf?: string,
  filters: ReportFilterParams = {}
): Promise<ArAgingReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<ArAgingReport>>(
    "/api/reports/ar-aging",
    { params: { asOf, ...filters } }
  );
  return unwrap(response.data);
}

/** GET /api/reports/collector-remittance — one batch's remittance reconciliation. */
export async function getCollectorRemittanceReport(
  batchId: string
): Promise<CollectorRemittanceReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<CollectorRemittanceReport>>(
    "/api/reports/collector-remittance",
    { params: { batchId } }
  );
  return unwrap(response.data);
}

/** GET /api/reports/outstanding-by-collector — receivables grouped by collector. */
export async function getOutstandingByCollectorReport(
  asOf?: string,
  filters: ReportFilterParams = {}
): Promise<OutstandingByCollectorReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<OutstandingByCollectorReport>>(
    "/api/reports/outstanding-by-collector",
    { params: { asOf, ...filters } }
  );
  return unwrap(response.data);
}

// ─── The reports added by S6-1 and S6-5 ───────────────────────────────────────
// Every getter here reads one of the extended reports the server exposes. The
// filter parameters are sent exactly as given: a report that does not honour a
// filter never receives it, and one that does always does (S6-2).

/**
 * The filters every report shares (S6-2).
 *
 * Only the subset a given report honours is sent; the Reports Center decides which
 * fields to render per report. Passing `undefined` omits the parameter entirely, so
 * an unfiltered report stays complete.
 */
export interface ReportFilterParams {
  /** First day of the range, inclusive. */
  fromDate?: string;
  /** Last day of the range, inclusive. */
  toDate?: string;
  /** Only rows whose account is assigned to this collector. */
  collectorId?: string;
  /** Only rows whose account sits in this collection area. */
  areaId?: string;
  /** Only rows whose account is on this plan. */
  planId?: string;
  /** Only rows whose plan is of this service type. */
  serviceType?: ServiceType;
}

/** The audit filters a report may carry (S6-5). */
export interface AuditReportParams extends ReportFilterParams {
  /** Only entries performed by this user. */
  performedBy?: string;
  /** Only entries with this action name. */
  action?: string;
  /** Only entries about this kind of entity. */
  entityType?: string;
}

/** One day or month of a weekly or annual collection summary. */
export interface CollectionPeriodSummary {
  /** A day ("2025-01-24") for a week, or a month ("2025-01") for a year. */
  periodKey: string;
  periodLabel: string;
  totals: PaymentTotals;
}

/** R7 — collections for one week, day by day. */
export interface WeeklyCollectionReport {
  fromDate: string;
  toDate: string;
  weekStartDate: string;
  periods: CollectionPeriodSummary[];
  totals: PaymentTotals;
}

/** R8 — collections for one year, month by month. */
export interface AnnualCollectionReport {
  fromDate: string;
  toDate: string;
  year: number;
  periods: CollectionPeriodSummary[];
  totals: PaymentTotals;
}

/** One group of a revenue decomposition: a plan, a service type, or an area. */
export interface RevenueGroup {
  groupKey: string;
  groupLabel: string;
  invoiceCount: number;
  billedCentavos: number;
  collectedCentavos: number;
  outstandingCentavos: number;
}

export type RevenueDimension = "plan" | "service_type" | "area";

/** R9 / R10 / R11 — billed revenue grouped by one dimension. */
export interface RevenueReport {
  dimension: RevenueDimension;
  fromDate: string;
  toDate: string;
  groups: RevenueGroup[];
  totals: RevenueGroup;
}

/** One service account together with the collector assigned to it. */
export interface CollectorAssignmentLine {
  collectorId: string | null;
  collectorName: string;
  subscriberName: string;
  serviceAccountNumber: string;
  planName: string;
  serviceType: ServiceType;
  areaName: string;
  accountStatus: ServiceAccountStatus;
}

/** R12 — who covers whom. */
export interface CollectorAssignmentReport {
  lines: CollectorAssignmentLine[];
  accountCount: number;
  collectorCount: number;
  areaCount: number;
}

/** One collector's collection and remittance figures. */
export interface CollectorPerformanceGroup {
  collectorId: string | null;
  collectorName: string;
  assignedAccountCount: number;
  paymentCount: number;
  collectedCentavos: number;
  cashCentavos: number;
  gcashCentavos: number;
  batchCount: number;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number;
  varianceCentavos: number;
}

/** R13 — what each collector collected and remitted. */
export interface CollectorPerformanceReport {
  fromDate: string;
  toDate: string;
  groups: CollectorPerformanceGroup[];
  /** The same shape as a group, so the totals row needs no special handling. */
  totals: CollectorPerformanceGroup;
}

/** One reversal, as both money reports show it. */
export interface PaymentAdjustmentLine {
  receiptNumber: string;
  reversalReceiptNumber: string;
  paymentDate: string;
  reversedAt: string;
  reason: string;
  reversedByName: string;
  paymentMethod: PaymentMethod;
  amountCentavos: number;
  subscriberName: string;
  serviceAccountNumber: string;
  collectorId: string | null;
  collectorName: string | null;
}

/** R14 — every payment reversal in a period. */
export interface PaymentAdjustmentReport {
  fromDate: string;
  toDate: string;
  lines: PaymentAdjustmentLine[];
  totals: {
    reversalCount: number;
    totalReversedCentavos: number;
    cashReversedCentavos: number;
    nonCashReversedCentavos: number;
  };
}

/** R15 — every receipt that no longer stands. */
export interface VoidedReceiptReport {
  fromDate: string;
  toDate: string;
  lines: PaymentAdjustmentLine[];
  totals: {
    receiptCount: number;
    totalVoidedCentavos: number;
    cashVoidedCentavos: number;
    gcashVoidedCentavos: number;
  };
}

/** One user/action pair of the user-activity summary. */
export interface UserActivityGroup {
  username: string;
  action: string;
  actionCount: number;
  lastPerformedAt: string;
}

/** R16 — auditable actions per user. */
export interface UserActivityReport {
  fromDate: string;
  toDate: string;
  groups: UserActivityGroup[];
  totals: {
    entryCount: number;
    userCount: number;
    distinctActionCount: number;
  };
}

/** One line of the subscriber master list. */
export interface SubscriberMasterListRow {
  subscriberId: string;
  subscriberAccountNumber: string;
  subscriberName: string;
  primaryPhone: string;
  emailAddress: string | null;
  serviceAddress: string;
  areaName: string | null;
  serviceAccountNumber: string | null;
  planName: string | null;
  serviceType: ServiceType | null;
  accountStatus: ServiceAccountStatus | null;
  collectorName: string | null;
}

/** R17 — every subscriber and their account. */
export interface SubscriberMasterListReport {
  rows: SubscriberMasterListRow[];
  subscriberCount: number;
  accountCount: number;
}

/** One row of the audit trail. */
export interface AuditLogEntry {
  performedAt: string;
  performedBy: string | null;
  performedByUsername: string | null;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  clientIpAddress: string | null;
}

/**
 * R18 / S6-5 — the audit trail as a report, capped and honest about the cap.
 *
 * `rows.length` is the number shown; `totalRows` is the number matched. When
 * `isTruncated` is true the screen says how many rows the cap omitted (S6-6).
 */
export interface AuditLogReport {
  fromDate: string;
  toDate: string;
  rows: AuditLogEntry[];
  totalRows: number;
  isTruncated: boolean;
  rowLimit: number;
}

/** GET /api/reports/weekly-collection — collections for a week, day by day. */
export async function getWeeklyCollectionReport(
  filters: ReportFilterParams = {}
): Promise<WeeklyCollectionReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<WeeklyCollectionReport>>(
    "/api/reports/weekly-collection",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/reports/annual-collection — collections for a year, month by month. */
export async function getAnnualCollectionReport(
  filters: ReportFilterParams & { year?: number } = {}
): Promise<AnnualCollectionReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<AnnualCollectionReport>>(
    "/api/reports/annual-collection",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/reports/revenue-by-plan|service-type|area — one revenue decomposition. */
export async function getRevenueReport(
  dimension: RevenueDimension,
  filters: ReportFilterParams = {}
): Promise<RevenueReport> {
  const path =
    dimension === "plan"
      ? "/api/reports/revenue-by-plan"
      : dimension === "service_type"
        ? "/api/reports/revenue-by-service-type"
        : "/api/reports/revenue-by-area";

  const response = await httpClient.get<ApiSuccessEnvelope<RevenueReport>>(path, {
    params: filters,
  });
  return unwrap(response.data);
}

/** GET /api/reports/collector-assignment — an assignment snapshot. */
export async function getCollectorAssignmentReport(
  filters: ReportFilterParams = {}
): Promise<CollectorAssignmentReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<CollectorAssignmentReport>>(
    "/api/reports/collector-assignment",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/reports/collector-performance — what each collector collected and remitted. */
export async function getCollectorPerformanceReport(
  filters: ReportFilterParams = {}
): Promise<CollectorPerformanceReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<CollectorPerformanceReport>>(
    "/api/reports/collector-performance",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/reports/payment-adjustments — every reversal in the range. */
export async function getPaymentAdjustmentReport(
  filters: ReportFilterParams = {}
): Promise<PaymentAdjustmentReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaymentAdjustmentReport>>(
    "/api/reports/payment-adjustments",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/reports/voided-receipts — every receipt that no longer stands. */
export async function getVoidedReceiptReport(
  filters: ReportFilterParams = {}
): Promise<VoidedReceiptReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<VoidedReceiptReport>>(
    "/api/reports/voided-receipts",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/reports/user-activity — audited actions per user and action. */
export async function getUserActivityReport(
  filters: AuditReportParams = {}
): Promise<UserActivityReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<UserActivityReport>>(
    "/api/reports/user-activity",
    { params: filters }
  );
  return unwrap(response.data);
}

/** The filters the subscriber master list honours: no date range, plus account status. */
export interface SubscriberMasterListParams extends ReportFilterParams {
  serviceStatus?: ServiceAccountStatus;
}

/** GET /api/reports/subscriber-master-list — every subscriber and their account. */
export async function getSubscriberMasterListReport(
  filters: SubscriberMasterListParams = {}
): Promise<SubscriberMasterListReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<SubscriberMasterListReport>>(
    "/api/reports/subscriber-master-list",
    { params: filters }
  );
  return unwrap(response.data);
}

/** GET /api/reports/audit-log — the audit trail as a report (S6-5). */
export async function getAuditLogReport(
  filters: AuditReportParams = {}
): Promise<AuditLogReport> {
  const response = await httpClient.get<ApiSuccessEnvelope<AuditLogReport>>(
    "/api/reports/audit-log",
    { params: filters }
  );
  return unwrap(response.data);
}

/** The file name the server put in Content-Disposition, or a fallback. */
function fileNameFromDisposition(disposition: string | undefined, fallback: string): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}

/** Reads one numeric response header, or null when it is absent or unreadable. */
function numericHeader(headers: Record<string, unknown>, name: string): number | null {
  const value = headers[name];
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Downloads a report in the requested format. Throws when the caller may not export. */
async function downloadReport(
  path: string,
  request: ReportExportRequest,
  fallbackFileName: string
): Promise<DownloadedReport> {
  const response = await httpClient.post<ArrayBuffer>(path, request, {
    responseType: "arraybuffer",
  });

  // The cap headers are how the server tells a caller its file is incomplete
  // (S6-6). They are read here, in the one place the renderer performs HTTP, so
  // every caller of an export sees the same truncation facts.
  const responseHeaders = response.headers as Record<string, unknown>;

  return {
    fileName: fileNameFromDisposition(response.headers["content-disposition"], fallbackFileName),
    bytes: response.data,
    rowLimit: numericHeader(responseHeaders, "x-report-row-cap"),
    totalRows: numericHeader(responseHeaders, "x-report-total-rows"),
    isTruncated: responseHeaders["x-report-truncated"] === "true",
  };
}

/** POST /api/reports/export-pdf — the report as a printable PDF document. */
export async function exportReportPdf(request: ReportExportRequest): Promise<DownloadedReport> {
  return downloadReport("/api/reports/export-pdf", request, `${request.reportType}.pdf`);
}

/** POST /api/reports/export-xlsx — the report as a spreadsheet. */
export async function exportReportXlsx(request: ReportExportRequest): Promise<DownloadedReport> {
  return downloadReport("/api/reports/export-xlsx", request, `${request.reportType}.xlsx`);
}

// ─── Phase 9: audit trail and system settings ─────────────────────────────────
// Same rule as above: this is the only place the renderer performs HTTP.

export interface AuditLogFilters {
  page?: number;
  pageSize?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
  performedBy?: string;
}

/** GET /api/audit-logs — one page of the audit trail (Admin only). */
export async function listAuditLogs(filters: AuditLogFilters = {}): Promise<PaginatedAuditLogs> {
  const response = await httpClient.get<ApiSuccessEnvelope<PaginatedAuditLogs>>("/api/audit-logs", {
    params: filters,
  });
  return unwrap(response.data);
}

/** GET /api/system/settings — the configurable business rules. */
export async function getSystemSettings(): Promise<SystemSetting[]> {
  const response =
    await httpClient.get<ApiSuccessEnvelope<{ items: SystemSetting[] }>>("/api/system/settings");
  return unwrap(response.data).items;
}

/** PUT /api/system/settings — updates one or more settings (Admin only). */
export async function updateSystemSettings(
  settings: { key: string; value: string }[]
): Promise<SystemSetting[]> {
  const response = await httpClient.put<ApiSuccessEnvelope<{ items: SystemSetting[] }>>(
    "/api/system/settings",
    { settings }
  );
  return unwrap(response.data).items;
}
