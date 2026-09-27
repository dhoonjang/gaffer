import { type OpsOrders } from "../common/orders-ops";

export const TRAINING_OPS: readonly string[] = [
  "sign_youth",
  "set_squad_number",
  "set_reserve_training",
  "set_development_focus",
  "set_mentor",
  "set_training",
];

export type TrainingOrders = OpsOrders;
