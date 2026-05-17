#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { stdin } from "node:process";
import {
  CheqiSDK,
  Environment,
  NoopLogger,
  ConsoleLogger,
  type IdentificationDetails,
  type NotificationDisplayCode
} from "@cheqi/sdk";

const VERSION = "0.1.0";
const CHEQI_DIR = ".cheqi";
const SESSIONS_DIR = ".cheqi/sessions";
const ACTIVE_SESSION_PATH = ".cheqi/active-session";

interface SubmitOptions {
  apiKey: string | null;
  accessToken: string | null;
  env: string;
  endpoint: string | null;
  receiptPath: string | null;
  matchBy: string | null;
  matchValue: string | null;
  timeoutSeconds: number;
  verbose: boolean;
  notificationDisplayCode: NotificationDisplayCode | null;
}

interface AuthOptions {
  apiKey: string | null;
  accessToken: string | null;
  env: string;
  endpoint: string | null;
  timeoutSeconds: number;
  verbose: boolean;
}

interface Session {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  auth: {
    env: string;
    endpoint: string | null;
  };
  identificationDetails: Record<string, unknown> | null;
  matchResponse: Record<string, unknown> | null;
  receipt: Record<string, unknown>;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0) {
    printUsage();
    return;
  }

  const [command, ...rest] = args;
  switch (command) {
    case "init":
      await initSession(rest);
      return;
    case "match":
      await matchSession(rest);
      return;
    case "add-product":
      await addProduct(rest);
      return;
    case "preview":
      await previewSession(rest);
      return;
    case "status":
      await statusSession(rest);
      return;
    case "finalize":
    case "finalize-receipt":
      await finalizeSession(rest);
      return;
    case "reset":
      await resetSession(rest);
      return;
    case "receipts":
      await receipts(rest);
      return;
    case "receipt":
      await receipt(rest);
      return;
    case "version":
      console.log(VERSION);
      return;
    case "help":
    case "-h":
    case "--help":
      printUsage();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function receipt(args: string[]): Promise<void> {
  if (args.length === 0) {
    printReceiptUsage();
    return;
  }

  const [command, ...rest] = args;
  switch (command) {
    case "set":
      await setReceipt(rest);
      return;
    case "add-product":
      await addProduct(rest);
      return;
    case "preview":
      await previewSession(rest);
      return;
    case "finalize":
      await finalizeSession(rest);
      return;
    case "help":
    case "-h":
    case "--help":
      printReceiptUsage();
      return;
    default:
      throw new Error(`Unknown receipt command: ${command}`);
  }
}

async function receipts(args: string[]): Promise<void> {
  if (args.length === 0) {
    printReceiptsUsage();
    return;
  }

  const [command, ...rest] = args;
  switch (command) {
    case "submit":
      await submitReceipt(rest);
      return;
    case "help":
    case "-h":
    case "--help":
      printReceiptsUsage();
      return;
    default:
      throw new Error(`Unknown receipts command: ${command}`);
  }
}

async function initSession(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const now = new Date().toISOString();
  const sessionId = resolveNewSessionId(flags);
  const session: Session = {
    version: 1,
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    auth: {
      env: stringFlag(flags, "env") ?? env("CHEQI_ENV") ?? "sandbox",
      endpoint: stringFlag(flags, "endpoint") ?? env("CHEQI_API_ENDPOINT")
    },
    identificationDetails: null,
    matchResponse: null,
    receipt: {
      documentNumber: stringFlag(flags, "document-number") ?? stringFlag(flags, "documentNumber") ?? `RECEIPT-${Date.now()}`,
      issueDate: parseIssueDate(stringFlag(flags, "issue-date") ?? stringFlag(flags, "issueDate") ?? "now"),
      currency: stringFlag(flags, "currency") ?? "EUR",
      receiptSubtotal: 0,
      totalBeforeTax: 0,
      totalTaxAmount: 0,
      totalAmount: 0,
      products: [],
      taxes: []
    }
  };

  const match = identificationDetailsFromFlags(flags);
  if (match) {
    session.identificationDetails = match as unknown as Record<string, unknown>;
  }

  await saveSession(session);
  await setActiveSession(session.id);
  printJson({
    sessionId: session.id,
    session: sessionPath(session.id),
    nextStep: session.identificationDetails
      ? `cheqi add-product --session ${session.id} --name ... --price-incl ... --vat ...`
      : `cheqi match --session ${session.id} --card-par ...`,
    receipt: session.receipt,
    hasMatch: Boolean(session.identificationDetails)
  });
}

async function matchSession(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const auth = parseAuthOptions(args);
  validateAuth(auth);

  const identificationDetails = identificationDetailsFromFlags(flags);
  if (!identificationDetails) {
    throw new Error("Provide one match flag: --card-par, --pairing-code, --payment-account-identifier, or --email");
  }

  const session = await loadOrCreateSession(auth, sessionIdFromFlags(flags));
  session.identificationDetails = identificationDetails as unknown as Record<string, unknown>;
  session.auth.env = auth.env;
  session.auth.endpoint = auth.endpoint;

  const sdk = buildSDK(auth).build();
  session.matchResponse = await sdk.matchingService.matchCustomer(
    identificationDetails,
    auth.accessToken
  ) as Record<string, unknown>;
  touch(session);
  await saveSession(session);
  await setActiveSession(session.id);

  printJson({
    sessionId: session.id,
    session: sessionPath(session.id),
    customerFound: session.matchResponse.customerFound,
    matchId: session.matchResponse.matchId,
    recipientCount: Array.isArray(session.matchResponse.recipients) ? session.matchResponse.recipients.length : 0,
    nextStep: `cheqi add-product --session ${session.id} --name ... --price-incl ... --vat ...`
  });
}

async function setReceipt(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const session = await loadSession(sessionIdFromFlags(flags));
  const receipt = session.receipt;

  setIfPresent(receipt, "documentNumber", stringFlag(flags, "document-number") ?? stringFlag(flags, "documentNumber"));
  setIfPresent(receipt, "currency", stringFlag(flags, "currency"));
  const issueDate = stringFlag(flags, "issue-date") ?? stringFlag(flags, "issueDate");
  if (issueDate) {
    receipt.issueDate = parseIssueDate(issueDate);
  }
  setIfPresent(receipt, "note", stringFlag(flags, "note"));

  touch(session);
  await saveSession(session);
  printJson({ sessionId: session.id, session: sessionPath(session.id), receipt });
}

async function addProduct(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const positionalName = flags._[0];
  const name = stringFlag(flags, "name") ?? positionalName;
  if (!name) {
    throw new Error("Product name is required. Use --name \"Nike Shoes\" or pass the name as the first argument.");
  }

  const quantity = numberFlag(flags, "quantity") ?? numberFlag(flags, "qty") ?? 1;
  const vatRate = numberFlag(flags, "vat") ?? numberFlag(flags, "tax-rate") ?? numberFlag(flags, "taxRate") ?? 0;
  const taxType = stringFlag(flags, "tax-type") ?? stringFlag(flags, "taxType") ?? "VAT";
  const unitCode = stringFlag(flags, "unit-code") ?? stringFlag(flags, "unitCode") ?? "C62";
  const brandName = stringFlag(flags, "brand") ?? stringFlag(flags, "brand-name") ?? "";
  const identifier = stringFlag(flags, "identifier") ?? stringFlag(flags, "sku") ?? "";

  const priceIncl = numberFlag(flags, "price-incl") ?? numberFlag(flags, "priceIncl") ?? numberFlag(flags, "gross");
  const unitPrice = numberFlag(flags, "unit-price") ?? numberFlag(flags, "unitPrice") ?? numberFlag(flags, "price-excl") ?? numberFlag(flags, "priceExcl");

  if (priceIncl === undefined && unitPrice === undefined) {
    throw new Error("Provide --price-incl or --unit-price");
  }

  const netUnitPrice = unitPrice ?? roundMoney((priceIncl as number) / (1 + vatRate / 100));
  const subtotal = roundMoney(netUnitPrice * quantity);
  const taxAmount = roundMoney(subtotal * (vatRate / 100));
  const total = priceIncl !== undefined ? roundMoney(priceIncl * quantity) : roundMoney(subtotal + taxAmount);
  const tax = {
    rate: vatRate,
    type: taxType,
    taxableAmount: subtotal,
    amount: taxAmount,
    label: stringFlag(flags, "tax-label") ?? stringFlag(flags, "taxLabel") ?? taxType
  };

  const product = {
    name,
    brandName,
    identifier,
    quantity,
    unitCode,
    unitPrice: netUnitPrice,
    taxes: [tax],
    subtotal,
    total
  };

  const session = await loadSession(sessionIdFromFlags(flags));
  const products = Array.isArray(session.receipt.products) ? session.receipt.products : [];
  products.push(product);
  session.receipt.products = products;
  recomputeTotals(session.receipt);

  touch(session);
  await saveSession(session);
  printJson({
    sessionId: session.id,
    session: sessionPath(session.id),
    added: product,
    totals: totals(session.receipt),
    nextStep: `cheqi preview --session ${session.id} or cheqi finalize-receipt --session ${session.id}`
  });
}

async function previewSession(args: string[] = []): Promise<void> {
  const session = await loadSession(sessionIdFromFlags(parseFlags(args)));
  recomputeTotals(session.receipt);
  printJson(session);
}

async function statusSession(args: string[] = []): Promise<void> {
  const session = await loadSession(sessionIdFromFlags(parseFlags(args)));
  printJson({
    sessionId: session.id,
    session: sessionPath(session.id),
    hasMatch: Boolean(session.identificationDetails),
    hasMatchResponse: Boolean(session.matchResponse),
    productCount: Array.isArray(session.receipt.products) ? session.receipt.products.length : 0,
    totals: totals(session.receipt),
    updatedAt: session.updatedAt
  });
}

async function finalizeSession(args: string[]): Promise<void> {
  const auth = parseAuthOptions(args);
  validateAuth(auth);
  const flags = parseFlags(args);
  const session = await loadSession(sessionIdFromFlags(flags));
  if (!session.identificationDetails) {
    throw new Error("No match details in the session. Run cheqi match first.");
  }
  validateReceiptDraft(session.receipt);
  recomputeTotals(session.receipt);

  const sdk = buildSDK({
    ...auth,
    env: stringFlag(flags, "env") ?? session.auth.env ?? auth.env,
    endpoint: stringFlag(flags, "endpoint") ?? session.auth.endpoint ?? auth.endpoint
  }).build();

  const result = await sdk.receiptService.processCompleteReceipt(
    session.identificationDetails as unknown as IdentificationDetails,
    session.receipt as never,
    auth.accessToken,
    null
  );

  const response = isRecord(result.response) ? result.response : null;
  printJson({
    success: result.success,
    deliveryMethod: result.deliveryMethod,
    customerFound: result.customerFound,
    receiptCount: result.receiptCount,
    cheqiReceiptId: typeof response?.cheqiReceiptId === "string" ? response.cheqiReceiptId : undefined,
    createdAt: typeof response?.createdAt === "string" ? response.createdAt : undefined,
    templateHash: typeof response?.templateHash === "string" ? response.templateHash : undefined,
    response: result.response,
    message: result.message,
    sessionId: session.id,
    session: sessionPath(session.id)
  });
}

async function resetSession(args: string[] = []): Promise<void> {
  const flags = parseFlags(args);
  const sessionId = sessionIdFromFlags(flags) ?? await getActiveSessionId();
  if (!sessionId) {
    await rm(ACTIVE_SESSION_PATH, { force: true });
    printJson({ reset: true });
    return;
  }
  await rm(sessionPath(sessionId), { force: true });
  const active = await getActiveSessionId();
  if (active === sessionId) {
    await rm(ACTIVE_SESSION_PATH, { force: true });
  }
  printJson({ sessionId, session: sessionPath(sessionId), reset: true });
}

async function submitReceipt(args: string[]): Promise<void> {
  const options = parseSubmitOptions(args);
  validateSubmitOptions(options);

  const sdk = CheqiSDK.builder()
    .apiEndpoint(resolveEndpoint(options))
    .timeoutSeconds(options.timeoutSeconds)
    .logger(options.verbose ? new ConsoleLogger() : new NoopLogger());

  if (options.apiKey) {
    sdk.apiKey(options.apiKey);
  }

  const client = sdk.build();
  const receipt = await readReceipt(options.receiptPath as string);
  const identificationDetails = buildIdentificationDetails(
    options.matchBy as string,
    options.matchValue as string
  );

  const result = await client.receiptService.processCompleteReceipt(
    identificationDetails,
    receipt as never,
    options.accessToken,
    options.notificationDisplayCode
  );

  const response = isRecord(result.response) ? result.response : null;
  printJson({
    success: result.success,
    deliveryMethod: result.deliveryMethod,
    customerFound: result.customerFound,
    receiptCount: result.receiptCount,
    cheqiReceiptId: typeof response?.cheqiReceiptId === "string" ? response.cheqiReceiptId : undefined,
    createdAt: typeof response?.createdAt === "string" ? response.createdAt : undefined,
    templateHash: typeof response?.templateHash === "string" ? response.templateHash : undefined,
    response: result.response,
    message: result.message,
    customerEmail: result.customerEmail
  });
}

function parseSubmitOptions(args: string[]): SubmitOptions {
  const options: SubmitOptions = {
    apiKey: env("CHEQI_API_KEY"),
    accessToken: env("CHEQI_ACCESS_TOKEN"),
    env: env("CHEQI_ENV") ?? "sandbox",
    endpoint: env("CHEQI_API_ENDPOINT"),
    receiptPath: null,
    matchBy: null,
    matchValue: null,
    timeoutSeconds: parsePositiveInt(env("CHEQI_TIMEOUT_SECONDS"), 30),
    verbose: false,
    notificationDisplayCode: null
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--api-key":
        options.apiKey = readFlagValue(args, ++index, arg);
        break;
      case "--access-token":
        options.accessToken = readFlagValue(args, ++index, arg);
        break;
      case "--env":
        options.env = readFlagValue(args, ++index, arg);
        break;
      case "--endpoint":
        options.endpoint = readFlagValue(args, ++index, arg);
        break;
      case "--receipt":
        options.receiptPath = readFlagValue(args, ++index, arg);
        break;
      case "--match-by":
        options.matchBy = readFlagValue(args, ++index, arg);
        break;
      case "--match-value":
        options.matchValue = readFlagValue(args, ++index, arg);
        break;
      case "--timeout":
        options.timeoutSeconds = parsePositiveInt(readFlagValue(args, ++index, arg), 30);
        break;
      case "--notification-display-code":
        options.notificationDisplayCode = parseNotificationDisplayCode(readFlagValue(args, ++index, arg));
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "-h":
      case "--help":
        printSubmitUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function validateSubmitOptions(options: SubmitOptions): void {
  if (!options.receiptPath) {
    throw new Error("--receipt is required");
  }
  if (!options.matchBy) {
    throw new Error("--match-by is required");
  }
  if (!options.matchValue) {
    throw new Error("--match-value is required");
  }
  if (!options.apiKey && !options.accessToken) {
    throw new Error("Set --api-key, --access-token, CHEQI_API_KEY, or CHEQI_ACCESS_TOKEN");
  }
  if (options.apiKey && options.accessToken) {
    throw new Error("Use either API key authentication or access token authentication, not both");
  }
}

function parseAuthOptions(args: string[]): AuthOptions {
  const flags = parseFlags(args);
  return {
    apiKey: stringFlag(flags, "api-key") ?? stringFlag(flags, "apiKey") ?? env("CHEQI_API_KEY"),
    accessToken: stringFlag(flags, "access-token") ?? stringFlag(flags, "accessToken") ?? env("CHEQI_ACCESS_TOKEN"),
    env: stringFlag(flags, "env") ?? env("CHEQI_ENV") ?? "sandbox",
    endpoint: stringFlag(flags, "endpoint") ?? env("CHEQI_API_ENDPOINT"),
    timeoutSeconds: parsePositiveInt(stringFlag(flags, "timeout") ?? env("CHEQI_TIMEOUT_SECONDS"), 30),
    verbose: booleanFlag(flags, "verbose")
  };
}

function validateAuth(options: AuthOptions): void {
  if (!options.apiKey && !options.accessToken) {
    throw new Error("Set --api-key, --access-token, CHEQI_API_KEY, or CHEQI_ACCESS_TOKEN");
  }
  if (options.apiKey && options.accessToken) {
    throw new Error("Use either API key authentication or access token authentication, not both");
  }
}

function buildSDK(options: AuthOptions) {
  const builder = CheqiSDK.builder()
    .apiEndpoint(resolveEndpoint(options))
    .timeoutSeconds(options.timeoutSeconds)
    .logger(options.verbose ? new ConsoleLogger() : new NoopLogger());

  if (options.apiKey) {
    builder.apiKey(options.apiKey);
  }

  return builder;
}

function resolveEndpoint(options: Pick<AuthOptions, "endpoint" | "env">): string {
  if (options.endpoint) {
    return options.endpoint;
  }

  switch (normalize(options.env)) {
    case "sandbox":
      return Environment.SANDBOX;
    case "test":
      return Environment.TEST;
    case "production":
    case "prod":
      return Environment.PRODUCTION;
    default:
      throw new Error(`Unsupported environment: ${options.env}`);
  }
}

type Flags = Record<string, string | boolean | string[]> & { _: string[] };

function parseFlags(args: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const equalsIndex = withoutPrefix.indexOf("=");
      if (equalsIndex >= 0) {
        flags[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
        continue;
      }
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        flags[withoutPrefix] = next;
        index++;
      } else {
        flags[withoutPrefix] = true;
      }
      continue;
    }

    const colonIndex = arg.indexOf(":");
    if (colonIndex > 0) {
      flags[arg.slice(0, colonIndex)] = arg.slice(colonIndex + 1);
      continue;
    }

    flags._.push(arg);
  }
  return flags;
}

function sessionIdFromFlags(flags: Flags): string | null {
  return sanitizeSessionId(stringFlag(flags, "session") ?? stringFlag(flags, "session-id") ?? stringFlag(flags, "sessionId"));
}

function resolveNewSessionId(flags: Flags): string {
  return sessionIdFromFlags(flags) ?? `receipt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeSessionId(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("Invalid session id");
  }
  return sanitized;
}

function sessionPath(sessionId: string): string {
  return `${SESSIONS_DIR}/${sessionId}.json`;
}

async function setActiveSession(sessionId: string): Promise<void> {
  await mkdir(CHEQI_DIR, { recursive: true });
  await writeFile(ACTIVE_SESSION_PATH, `${sessionId}\n`, "utf8");
}

async function getActiveSessionId(): Promise<string | null> {
  try {
    return sanitizeSessionId((await readFile(ACTIVE_SESSION_PATH, "utf8")).trim());
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolveExistingSessionId(requestedSessionId: string | null): Promise<string> {
  const sessionId = requestedSessionId ?? await getActiveSessionId();
  if (!sessionId) {
    throw new Error("No active Cheqi session found. Run cheqi init or pass --session <id>.");
  }
  return sessionId;
}

function stringFlag(flags: Flags, name: string): string | null {
  const value = flags[name];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return null;
}

function numberFlag(flags: Flags, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === null) {
    return undefined;
  }
  const normalized = value.replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFlag(flags: Flags, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

function identificationDetailsFromFlags(flags: Flags): IdentificationDetails | null {
  const cardPar = stringFlag(flags, "card-par") ?? stringFlag(flags, "cardPar");
  if (cardPar) {
    return buildIdentificationDetails("card_par", cardPar);
  }

  const pairingCode = stringFlag(flags, "pairing-code") ?? stringFlag(flags, "pairingCode");
  if (pairingCode) {
    return buildIdentificationDetails("pairing_code", pairingCode);
  }

  const paymentAccountIdentifier = stringFlag(flags, "payment-account-identifier")
    ?? stringFlag(flags, "paymentAccountIdentifier")
    ?? stringFlag(flags, "iban");
  if (paymentAccountIdentifier) {
    return buildIdentificationDetails("payment_account_identifier", paymentAccountIdentifier);
  }

  const email = stringFlag(flags, "email");
  if (email) {
    return buildIdentificationDetails("email", email);
  }

  return null;
}

async function readReceipt(path: string): Promise<Record<string, unknown>> {
  const raw = path === "-" ? await readStdin() : await readFile(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function loadSession(requestedSessionId: string | null = null): Promise<Session> {
  const sessionId = await resolveExistingSessionId(requestedSessionId);
  let raw: string;
  try {
    raw = await readFile(sessionPath(sessionId), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`No Cheqi session found for ${sessionId}. Run cheqi init --session ${sessionId} first.`);
    }
    throw error;
  }
  const session = JSON.parse(raw) as Session;
  if (!session.id) {
    session.id = sessionId;
  }
  return session;
}

async function loadOrCreateSession(auth: AuthOptions, requestedSessionId: string | null = null): Promise<Session> {
  try {
    return await loadSession(requestedSessionId);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("No Cheqi session found")) {
      throw error;
    }
    const now = new Date().toISOString();
    const sessionId = requestedSessionId ?? `receipt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      version: 1,
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      auth: {
        env: auth.env,
        endpoint: auth.endpoint
      },
      identificationDetails: null,
      matchResponse: null,
      receipt: {
        documentNumber: `RECEIPT-${Date.now()}`,
        issueDate: now,
        currency: "EUR",
        receiptSubtotal: 0,
        totalBeforeTax: 0,
        totalTaxAmount: 0,
        totalAmount: 0,
        products: [],
        taxes: []
      }
    };
  }
}

async function saveSession(session: Session): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const path = sessionPath(session.id);
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function touch(session: Session): void {
  session.updatedAt = new Date().toISOString();
}

function parseIssueDate(value: string): string {
  if (normalize(value) === "now") {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid issue date: ${value}`);
  }
  return date.toISOString();
}

function recomputeTotals(receipt: Record<string, unknown>): void {
  const products = Array.isArray(receipt.products) ? receipt.products.filter(isRecord) : [];
  const subtotal = roundMoney(products.reduce((sum, product) => sum + numberValue(product.subtotal), 0));
  const taxTotal = roundMoney(products.reduce((sum, product) => {
    const taxes = Array.isArray(product.taxes) ? product.taxes.filter(isRecord) : [];
    return sum + taxes.reduce((innerSum, tax) => innerSum + numberValue(tax.amount), 0);
  }, 0));
  const total = roundMoney(products.reduce((sum, product) => sum + numberValue(product.total), 0));
  const taxMap = new Map<string, { rate: number; type: string; taxableAmount: number; amount: number; label?: string }>();

  for (const product of products) {
    const taxes = Array.isArray(product.taxes) ? product.taxes.filter(isRecord) : [];
    for (const tax of taxes) {
      const rate = numberValue(tax.rate);
      const type = typeof tax.type === "string" ? tax.type : "VAT";
      const label = typeof tax.label === "string" ? tax.label : type;
      const key = `${type}:${rate}:${label}`;
      const existing = taxMap.get(key) ?? { rate, type, label, taxableAmount: 0, amount: 0 };
      existing.taxableAmount = roundMoney(existing.taxableAmount + numberValue(tax.taxableAmount));
      existing.amount = roundMoney(existing.amount + numberValue(tax.amount));
      taxMap.set(key, existing);
    }
  }

  receipt.receiptSubtotal = subtotal;
  receipt.totalBeforeTax = subtotal;
  receipt.totalTaxAmount = taxTotal;
  receipt.totalAmount = total;
  receipt.taxes = Array.from(taxMap.values());
}

function totals(receipt: Record<string, unknown>): Record<string, unknown> {
  return {
    receiptSubtotal: receipt.receiptSubtotal,
    totalBeforeTax: receipt.totalBeforeTax,
    totalTaxAmount: receipt.totalTaxAmount,
    totalAmount: receipt.totalAmount
  };
}

function validateReceiptDraft(receipt: Record<string, unknown>): void {
  const required = ["documentNumber", "issueDate", "currency"];
  for (const field of required) {
    if (typeof receipt[field] !== "string" || receipt[field] === "") {
      throw new Error(`Receipt ${field} is required. Run cheqi receipt set --${field} ...`);
    }
  }
  if (!Array.isArray(receipt.products) || receipt.products.length === 0) {
    throw new Error("At least one product is required. Run cheqi add-product --name ... --price-incl ...");
  }
}

function setIfPresent(target: Record<string, unknown>, key: string, value: string | null): void {
  if (value !== null) {
    target[key] = value;
  }
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildIdentificationDetails(matchBy: string, value: string): IdentificationDetails {
  switch (normalize(matchBy)) {
    case "card_par":
      return {
        paymentType: "CARD_PAYMENT",
        cardDetails: { paymentAccountReference: value }
      } as IdentificationDetails;
    case "pairing_code":
      return {
        paymentType: "CASH",
        pairingCode: value
      } as IdentificationDetails;
    case "payment_account_identifier":
      return {
        paymentType: "DIRECT_DEBIT",
        paymentAccountDetails: {
          accountIdentifierType: "IBAN",
          identifier: value
        }
      } as IdentificationDetails;
    case "email":
      return {
        paymentType: "CASH",
        recipientEmail: value
      } as IdentificationDetails;
    default:
      throw new Error("Unsupported --match-by. Use card_par, pairing_code, payment_account_identifier, or email");
  }
}

function parseNotificationDisplayCode(raw: string): NotificationDisplayCode {
  const value = JSON.parse(raw);
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.data !== "string") {
    throw new Error("--notification-display-code must be JSON with string fields type and data");
  }
  return value as unknown as NotificationDisplayCode;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printUsage(): void {
  console.log(`Usage:
  cheqi init [--session <id>] [--currency EUR]
  cheqi match [--session <id>] --card-par <par>
  cheqi receipt set [--session <id>] --document-number <id> --currency <currency>
  cheqi add-product [--session <id>] --name <name> --price-incl <amount> --vat <rate>
  cheqi preview [--session <id>]
  cheqi finalize-receipt [--session <id>]
  cheqi receipts submit --match-by <type> --match-value <value> --receipt <file>
  cheqi version

Use --session for concurrent agent workflows. Sessions are stored in .cheqi/sessions.
Run "cheqi receipt help" for session receipt commands.
Run "cheqi receipts help" for direct JSON submission.`);
}

function printReceiptsUsage(): void {
  console.log(`Usage:
  cheqi receipts submit [flags]

Run "cheqi receipts submit --help" for flags.`);
}

function printReceiptUsage(): void {
  console.log(`Usage:
  cheqi receipt set [--session <id>] --document-number INV-001 --currency EUR
  cheqi receipt add-product [--session <id>] --name "Nike Shoes" --price-incl 200 --vat 21
  cheqi receipt preview [--session <id>]
  cheqi receipt finalize [--session <id>]

Aliases:
  cheqi add-product ...
  cheqi preview
  cheqi finalize-receipt`);
}

function printSubmitUsage(): void {
  console.log(`Usage:
  cheqi receipts submit \\
    --match-by card_par \\
    --match-value YOUR_CARD_PAR \\
    --receipt receipt.json

Flags:
  --receipt <file>                      ReceiptTemplateRequest JSON file, or - for stdin
  --match-by <type>                     card_par, pairing_code, payment_account_identifier, or email
  --match-value <value>                 matching value
  --api-key <key>                       API key, or CHEQI_API_KEY
  --access-token <token>                OAuth access token, or CHEQI_ACCESS_TOKEN
  --env <env>                           sandbox, test, or production; defaults to sandbox
  --endpoint <url>                      custom API endpoint, or CHEQI_API_ENDPOINT
  --timeout <seconds>                   request timeout; defaults to 30
  --notification-display-code <json>    optional JSON object with type and data
  --verbose                             enable sanitized SDK logs`);
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
});
