-- Agent hand replays: a step-by-step timeline of each Agent hand (seats, blinds, every action with the pot and stack
-- after it, the board per street, showdown hands, pot awards, net per seat), for the Session History replay viewer.
-- Recorded by the dedicated server already privacy-filtered: an opponent's hole cards appear only when they were
-- shown at showdown. NULL for hands recorded before replays existed (the viewer then shows the old summary fields).
ALTER TABLE agent_hands ADD COLUMN IF NOT EXISTS replay_json JSONB;
