-- A player's own profile picture (uploaded image, stored in R2 at pictures/<key>.webp and served by the API at
-- /v1/pictures/<key>.webp). NULL: the player uses an AvatarCatalog picture (players.avatar). A new upload gets a new
-- key, so the old URL can be cached forever.
ALTER TABLE players ADD COLUMN picture TEXT;
