-- Track whether agency has completed the onboarding wizard
ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false;
