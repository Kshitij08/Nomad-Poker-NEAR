/** Setup parameters for a table. Port of Core/Engine/TableConfig.cs (same defaults). */
export interface TableConfig {
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
}

export function tableConfig(init: Partial<TableConfig> = {}): TableConfig {
  return { seatCount: 6, smallBlind: 25, bigBlind: 50, startingStack: 5000, ...init };
}
