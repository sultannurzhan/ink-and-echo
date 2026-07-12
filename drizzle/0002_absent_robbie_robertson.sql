DROP INDEX `players_room_seat_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `players_room_seat_uq` ON `players` (`room_code`,`seat`) WHERE "players"."left_at" IS NULL;