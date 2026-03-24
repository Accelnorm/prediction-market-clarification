// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STORE = { payments: [] };

export class FileVerifiedPaymentRepository {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        payments: Array.isArray(parsed.payments) ? parsed.payments : []
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { ...EMPTY_STORE };
      }

      throw error;
    }
  }

  async save(payments) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ payments }, null, 2) + "\n", "utf8");
  }

  async create(payment) {
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

  async findByPaymentProof(paymentProof) {
    const store = await this.load();
    return (
      store.payments.find(
        (payment) =>
          typeof payment.paymentProof === "string" && payment.paymentProof === paymentProof
      ) ?? null
    );
  }

  async findByPaymentReference(paymentReference) {
    const store = await this.load();
    return (
      store.payments.find(
        (payment) =>
          typeof payment.paymentReference === "string" &&
          payment.paymentReference === paymentReference
      ) ?? null
    );
  }

  async updateByPaymentProof(paymentProof, updates) {
    return this.withWriteLock(async () => {
      const store = await this.load();
      const paymentIndex = store.payments.findIndex(
        (payment) => payment.paymentProof === paymentProof
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

  async withWriteLock(work) {
    const nextOperation = this.writeChain.then(work);
    this.writeChain = nextOperation.catch(() => {});
    return nextOperation;
  }
}
