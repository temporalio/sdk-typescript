import type { PayloadTypeInfo, TypeInfo } from '@temporalio/common';

export class Order {
  constructor(
    readonly id: string,
    readonly totalCents: bigint,
    readonly remainingRuns = 0
  ) {}

  summary(): string {
    return `${this.id}:${this.totalCents}:${this.remainingRuns}`;
  }
}

export class Receipt {
  constructor(
    readonly orderId: string,
    readonly totalCents: bigint
  ) {}

  summary(): string {
    return `${this.orderId}:${this.totalCents}`;
  }
}

interface OrderDto {
  id: string;
  totalCents: string;
  remainingRuns: number;
}

interface ReceiptDto {
  orderId: string;
  totalCents: string;
}

export const orderTypeInfo: TypeInfo<Order, OrderDto> = {
  transferTypeConverter: {
    toTransferType(value: Order): OrderDto {
      return { id: value.id, totalCents: value.totalCents.toString(), remainingRuns: value.remainingRuns };
    },
    fromTransferType(value: OrderDto): Order {
      return new Order(value.id, BigInt(value.totalCents), value.remainingRuns ?? 0);
    },
  },
};

export const receiptTypeInfo: TypeInfo<Receipt, ReceiptDto> = {
  transferTypeConverter: {
    toTransferType(value: Receipt): ReceiptDto {
      return { orderId: value.orderId, totalCents: value.totalCents.toString() };
    },
    fromTransferType(value: ReceiptDto): Receipt {
      return new Receipt(value.orderId, BigInt(value.totalCents));
    },
  },
};

export const workflowTypeInfo: PayloadTypeInfo = {
  inputTypes: [orderTypeInfo],
  outputType: receiptTypeInfo,
};

export function assertOrder(order: Order): void {
  if (!(order instanceof Order)) {
    throw new Error('Expected Order input');
  }
  if (typeof order.totalCents !== 'bigint') {
    throw new Error('Expected Order.totalCents to be a bigint');
  }
}

export function assertReceipt(receipt: Receipt): void {
  if (!(receipt instanceof Receipt)) {
    throw new Error('Expected Receipt result');
  }
  if (typeof receipt.totalCents !== 'bigint') {
    throw new Error('Expected Receipt.totalCents to be a bigint');
  }
}
