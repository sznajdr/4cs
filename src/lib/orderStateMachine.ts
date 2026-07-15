export type OrderClientState =
  | 'draft'
  | 'sent'
  | 'acked'
  | 'partial'
  | 'filled'
  | 'rejected'
  | 'cancelling'
  | 'cancelled';

export type OrderEvent =
  | { kind: 'submit' }
  | { kind: 'serverAck'; orderId: string }
  | { kind: 'partialFill'; amount: number }
  | { kind: 'fill' }
  | { kind: 'reject'; reason?: string }
  | { kind: 'cancel' }
  | { kind: 'cancelAck' }
  | { kind: 'cancelReject'; reason?: string };

export interface OrderModel {
  state: OrderClientState;
  clientRef: string;
  serverId?: string;
  filled: number;
  errorReason?: string;
}

export interface TransitionResult {
  next: OrderModel;
  ok: boolean;
  reason?: string;
}

function ignore(next: OrderModel, reason: string): TransitionResult {
  return { next, ok: false, reason };
}

function accept(next: OrderModel): TransitionResult {
  return { next, ok: true };
}

const TERMINAL: ReadonlySet<OrderClientState> = new Set(['filled', 'rejected', 'cancelled']);

export function createOrder(clientRef: string): OrderModel {
  return { state: 'draft', clientRef, filled: 0 };
}

export function transition(model: OrderModel, event: OrderEvent): TransitionResult {
  if (TERMINAL.has(model.state)) {
    return ignore(model, `event ${event.kind} ignored; order is ${model.state}`);
  }

  switch (event.kind) {
    case 'submit':
      if (model.state !== 'draft') return ignore(model, `cannot submit from ${model.state}`);
      return accept({ ...model, state: 'sent' });

    case 'serverAck':
      if (model.state !== 'sent') return ignore(model, `unexpected serverAck in ${model.state}`);
      return accept({ ...model, state: 'acked', serverId: event.orderId });

    case 'partialFill':
      if (model.state !== 'acked' && model.state !== 'partial') {
        return ignore(model, `partialFill not allowed in ${model.state}`);
      }
      return accept({ ...model, state: 'partial', filled: model.filled + event.amount });

    case 'fill':
      if (model.state !== 'acked' && model.state !== 'partial') {
        return ignore(model, `fill not allowed in ${model.state}`);
      }
      return accept({ ...model, state: 'filled' });

    case 'reject':
      if (model.state === 'sent' || model.state === 'acked' || model.state === 'partial') {
        return accept({ ...model, state: 'rejected', errorReason: event.reason });
      }
      if (model.state === 'cancelling') {
        return accept({ ...model, state: 'cancelled', errorReason: event.reason });
      }
      return ignore(model, `reject not allowed in ${model.state}`);

    case 'cancel':
      if (model.state !== 'acked' && model.state !== 'partial') {
        return ignore(model, `cancel not allowed in ${model.state}`);
      }
      return accept({ ...model, state: 'cancelling' });

    case 'cancelAck':
      if (model.state !== 'cancelling') return ignore(model, `unexpected cancelAck in ${model.state}`);
      return accept({ ...model, state: 'cancelled' });

    case 'cancelReject': {
      if (model.state !== 'cancelling') return ignore(model, `unexpected cancelReject in ${model.state}`);
      const reverted: OrderClientState = model.filled > 0 ? 'partial' : 'acked';
      return accept({ ...model, state: reverted, errorReason: event.reason });
    }
  }
}
