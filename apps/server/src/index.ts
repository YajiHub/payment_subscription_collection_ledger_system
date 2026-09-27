// Entry point — builds Fastify, registers every module, starts listening.
//
// Run with:  pnpm dev:server          (from the monorepo root)
//            pnpm --filter server dev

import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { config } from "./config";
import { closeDatabaseConnection } from "./db/connection";
import { registerAuditRoutes } from "./modules/audit/audit.routes";
import { registerAuthRoutes } from "./modules/auth/auth.routes";
import { registerBackupRoutes } from "./modules/backup/backup.routes";
import { registerBillingRoutes } from "./modules/billing/billing.routes";
import { registerInvoiceRoutes } from "./modules/billing/invoices.routes";
import { registerCollectorBatchRoutes } from "./modules/collections/collector-batches.routes";
import { registerDashboardRoutes } from "./modules/dashboard/dashboard.routes";
import { registerHealthRoutes } from "./modules/health/health.routes";
import { registerLedgerRoutes } from "./modules/ledger/ledger.routes";
import { registerPaymentRoutes } from "./modules/payments/payments.routes";
import { registerPlanRoutes } from "./modules/plans/plans.routes";
import { registerReceivablesRoutes } from "./modules/receivables/receivables.routes";
import { registerReportRoutes } from "./modules/reports/reports.routes";
import { registerServiceAccountRoutes } from "./modules/service-accounts/service-accounts.routes";
import { registerSubscriberRoutes } from "./modules/subscribers/subscribers.routes";
import { registerSystemRoutes } from "./modules/system/system.routes";
import { ensureSystemSettingsSeeded } from "./modules/system/system-settings.service";
import { registerUserRoutes } from "./modules/users/users.routes";
import { isAppError } from "./shared/errors";
import { securityPlugin } from "./shared/plugins/security.plugin";
import { validationPlugin } from "./shared/plugins/validation.plugin";
import { startPermissionCacheRefresh, ensurePermissionCacheLoaded } from "./shared/rbac/permission-resolver";
import { sendError } from "./shared/response";

const isDevelopment = config.NODE_ENV === "development";

const loggerOptions: FastifyServerOptions["logger"] = isDevelopment
  ? { level: "info", transport: { target: "pino-pretty" } }
  : { level: "warn" };

/** Phase 9 §4: the largest JSON request body the API will accept (1 MB). */
const JSON_BODY_LIMIT_BYTES = 1_048_576;

/**
 * Every route module the server registers, in registration order.
 *
 * Exported as data so the RBAC sweep test derives its module list from here rather
 * than re-listing the modules by hand: a new module added to this array is swept
 * automatically and cannot silently escape the authorization matrix.
 */
export const ROUTE_REGISTRARS: readonly ((
  server: FastifyInstance
) => Promise<void>)[] = [
  registerHealthRoutes,
  registerAuthRoutes,
  registerUserRoutes,
  registerPlanRoutes,
  registerSubscriberRoutes,
  registerServiceAccountRoutes,
  registerBillingRoutes,
  registerInvoiceRoutes,
  registerPaymentRoutes,
  registerLedgerRoutes,
  registerCollectorBatchRoutes,
  registerReceivablesRoutes,
  registerDashboardRoutes,
  registerReportRoutes,
  registerAuditRoutes,
  registerSystemRoutes,
  registerBackupRoutes,
];

/**
 * Installs plugins and routes in the order they must run.
 *
 * It is registered as ONE plugin because Fastify installs a plugin's hooks when
 * the plugin is loaded. The security plugins must finish loading before any route
 * is compiled, or the rate-limit hook never attaches to the routes that were
 * queued ahead of it.
 */
async function registerApplication(server: FastifyInstance): Promise<void> {
  validationPlugin(server);
  await securityPlugin(server);

  for (const registerRoutes of ROUTE_REGISTRARS) {
    await server.register(registerRoutes);
  }
}

/** Creates the Fastify instance with every plugin, route, and error handler applied. */
export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: loggerOptions, bodyLimit: JSON_BODY_LIMIT_BYTES });

  server.register(registerApplication);

  // Turns thrown errors into one predictable JSON shape.
  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (isAppError(error)) {
      request.log.warn({ code: error.code }, error.message);
      return sendError(reply, error.statusCode, error.code, error.message);
    }

    // Fastify validation errors carry a statusCode of their own.
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return sendError(reply, 500, "INTERNAL_ERROR", "An unexpected error occurred");
    }

    return sendError(reply, statusCode, "VALIDATION_ERROR", error.message);
  });

  server.setNotFoundHandler((request, reply) => {
    return sendError(reply, 404, "NOT_FOUND", `Route ${request.method} ${request.url} not found`);
  });

  return server;
}

async function startServer(): Promise<void> {
  const server = buildServer();

  // Resolve the permission matrix from the RBAC tables (S1-2, S12-9) and AWAIT it
  // before the first request is served, so there is no boot window in which
  // authorization is unresolved. A failure leaves the cache failing closed rather
  // than falling back to the compiled matrix.
  await ensurePermissionCacheLoaded();
  startPermissionCacheRefresh();

  // A fresh database is seeded with the default business rules. A failure must
  // not stop the server from starting: the health endpoint reports the database
  // as unreachable instead.
  try {
    await ensureSystemSettingsSeeded();
  } catch (error) {
    server.log.warn({ err: error }, "Could not seed system settings on startup");
  }

  try {
    await server.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }

  // Close connections cleanly so in-flight requests finish before the process exits.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close().then(async () => {
        await closeDatabaseConnection();
        server.log.info(`Received ${signal} — server stopped`);
        process.exit(0);
      });
    });
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  void startServer();
}
