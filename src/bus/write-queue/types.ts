/** WriteOp -- Payload type for the DB write queue. */
export interface WriteOp {
  tableName: string;
  opType: 'insert' | 'upsert' | 'update' | 'delete' | 'raw';
  sql: string;
  params?: unknown[];
}
