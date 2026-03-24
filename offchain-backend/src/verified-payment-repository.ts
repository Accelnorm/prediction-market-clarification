import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VerifiedPayment } from "./types.js";

const EMPTY_STORE: { payments: VerifiedPayment[] } = { payments: [] };

export class FileVerifiedPaymentRepository {
  private filePath: string;
  private writeChain: Promise<unknown>;
  constructor(filePath: string) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load(): Promise<{ payments: VerifiedPayment[] }> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        payments: Array.isArray(parsed.payments) ? parsed.payments : []
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(payments: VerifiedPayment[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ payments }, null, 2) + "\n", "utf8");
  }

  async create(payment: VerifiedPayment) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const payments = [
        ...store.payments,
        {
          ...payment,
          clarificationId: payment.clarificationId ?? null,
          createdAt: payment.createdAt ?? payment.paymentVerifiedAt ?? null,
          updatedAt: payment.updatedAt ?? payment.paymentVerifiedAt ?? null
        }
      ];
      await this.save(payments);
      return payments.at(-1);
    });
  }

  async findByPaymentProof(paymentProof: string): Promise<VerifiedPayment | null> {
    const store = await this.load();
    return (
      store.payments.find(
        (payment: VerifiedPayment) =>
          typeof payment.paymentProof === "string" && payment.paymentProof === paymentProof
      ) ?? null
    );
  }

  async findByPaymentReference(paymentReference: string): Promise<VerifiedPayment | null> {
    const store = await this.load();
    return (
      store.payments.find(
        (payment: VerifiedPayment) =>
          typeof payment.paymentReference === "string" &&
          payment.paymentReference === paymentReference
      ) ?? null
    );
  }

  async updateByPaymentProof(paymentProof: string, updates: Partial<VerifiedPayment>) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const paymentIndex = store.payments.findIndex(
        (payment: VerifiedPayment) => payment.paymentProof === paymentProof
      );

      if (paymentIndex === -1) {
        return null;
      }

      const existingPayment = store.payments[paymentIndex];
      const nextPayment = {
        ...existingPayment,
        ...updates,
        updatedAt: updates.updatedAt ?? existingPayment.updatedAt
      };
      const payments = [...store.payments];
      payments[paymentIndex] = nextPayment;
      await this.save(payments);
      return nextPayment;
    });
  }

  async list() {
    const store = await this.load();
    return store.payments;
  }

  async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
