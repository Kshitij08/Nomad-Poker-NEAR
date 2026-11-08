-- Phase 7: how long a player took over each decision (from the table asking to the action arriving), for bot
-- detection (integrity.ts). NULL on rows recorded before this column.
ALTER TABLE style_decisions ADD COLUMN think_ms INTEGER;
