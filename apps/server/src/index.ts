// Entry point — builds Fastify, registers every module, starts listening.
//
// Run with:  pnpm dev:server          (from the monorepo root)
//            pnpm --filter server dev

import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import { config } from "./config";
import { closeDatabaseConnection } from "./db/connection";
import { registerAuthRoutes } from "./modules/auth/auth.routes";
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
import { registerUserRoutes } from "./modules/users/users.routes";
import { isAppError } from "./shared/errors";
import { sendError } from "./shared/response";

const isDevelopment = config.NODE_ENV === "development";

const loggerOptions: FastifyServerOptions["logger"] = isDevelopment
  ? { level: "info", transport: { target: "pino-pretty" } }
  : { level: "warn" };

/** Creates the Fastify instance with every plugin, route, and error handler applied. */
export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: loggerOptions });

  server.register(cors, { origin: config.CORS_ORIGIN });
  server.register(registerHealthRoutes);
  server.register(registerAuthRoutes);
  server.register(registerUserRoutes);
  server.register(registerPlanRoutes);
  server.register(registerSubscriberRoutes);
  server.register(registerServiceAccountRoutes);
  server.register(registerBillingRoutes);
  server.register(registerInvoiceRoutes);
  server.register(registerPaymentRoutes);
  server.register(registerLedgerRoutes);
  server.register(registerCollectorBatchRoutes);
  server.register(registerReceivablesRoutes);
  server.register(registerDashboardRoutes);
  server.register(registerReportRoutes);

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
