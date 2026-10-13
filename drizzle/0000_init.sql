CREATE TABLE `auth_accounts` (
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	PRIMARY KEY(`provider`, `provider_account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `availability` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`mode` text NOT NULL,
	`blocks` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_user_week_uq` ON `availability` (`user_id`,`week_start`);--> statement-breakpoint
CREATE TABLE `festival_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`days` integer NOT NULL,
	`film_count` integer NOT NULL,
	`availability_snapshot` text NOT NULL,
	`avoid` text NOT NULL,
	`reroll_count` integer DEFAULT 0 NOT NULL,
	`job_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `festival_requests_user_idx` ON `festival_requests` (`user_id`);--> statement-breakpoint
CREATE TABLE `festivals` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`title` text NOT NULL,
	`statement_md` text NOT NULL,
	`concept` text NOT NULL,
	`alternatives` text NOT NULL,
	`selection_trace` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`google_calendar_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `festival_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `festivals_user_created_idx` ON `festivals` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `festivals_request_idx` ON `festivals` (`request_id`);--> statement-breakpoint
CREATE TABLE `film_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`title_raw` text NOT NULL,
	`year_raw` integer,
	`imdb_id_raw` text,
	`tmdb_id` integer,
	`match_status` text DEFAULT 'pending' NOT NULL,
	`match_confidence` real,
	`candidates` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tmdb_id`) REFERENCES `films`(`tmdb_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `film_aliases_provider_ext_uq` ON `film_aliases` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `film_aliases_tmdb_idx` ON `film_aliases` (`tmdb_id`);--> statement-breakpoint
CREATE INDEX `film_aliases_status_idx` ON `film_aliases` (`match_status`);--> statement-breakpoint
CREATE TABLE `films` (
	`tmdb_id` integer PRIMARY KEY NOT NULL,
	`imdb_id` text,
	`title_en` text NOT NULL,
	`title_zh` text,
	`original_title` text NOT NULL,
	`year` integer,
	`runtime_min` integer,
	`countries` text DEFAULT '[]' NOT NULL,
	`languages` text DEFAULT '[]' NOT NULL,
	`genres` text DEFAULT '[]' NOT NULL,
	`directors` text DEFAULT '[]' NOT NULL,
	`cast_top` text DEFAULT '[]' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`overview_en` text,
	`overview_zh` text,
	`poster_path` text,
	`vote_avg` real,
	`vote_count` integer,
	`popularity` real,
	`release_date` text,
	`enriched_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`heartbeat_at` text,
	`result` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_status_created_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_user_idx` ON `jobs` (`user_id`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text,
	`job_id` text,
	`purpose` text NOT NULL,
	`prompt_version` text,
	`model` text NOT NULL,
	`effort` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`request_hash` text NOT NULL,
	`response` text,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `llm_calls_user_idx` ON `llm_calls` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `llm_calls_request_hash_idx` ON `llm_calls` (`request_hash`);--> statement-breakpoint
CREATE TABLE `screenings` (
	`id` text PRIMARY KEY NOT NULL,
	`festival_id` text NOT NULL,
	`user_id` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`program_note_md` text NOT NULL,
	`starts_at` text,
	`ends_at` text,
	`unscheduled_reason` text,
	`calendar_uid` text NOT NULL,
	`calendar_sequence` integer DEFAULT 0 NOT NULL,
	`google_event_id` text,
	`feedback` text,
	`feedback_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`festival_id`) REFERENCES `festivals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tmdb_id`) REFERENCES `films`(`tmdb_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `screenings_festival_idx` ON `screenings` (`festival_id`);--> statement-breakpoint
CREATE INDEX `screenings_user_starts_idx` ON `screenings` (`user_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`session_token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `source_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`handle` text NOT NULL,
	`auth_enc` text,
	`sync_mode` text NOT NULL,
	`cursor` text,
	`last_sync_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_accounts_user_idx` ON `source_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `taste_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`watch_log_hash` text NOT NULL,
	`watch_log_count` integer DEFAULT 0 NOT NULL,
	`stats` text NOT NULL,
	`memo` text,
	`memo_md` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taste_profiles_user_version_uq` ON `taste_profiles` (`user_id`,`version`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`name` text,
	`email_verified` integer,
	`image` text,
	`locale` text DEFAULT 'zh-CN' NOT NULL,
	`tz` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`calendar_token` text NOT NULL,
	`prefs` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_calendar_token_unique` ON `users` (`calendar_token`);--> statement-breakpoint
CREATE TABLE `auth_verification_tokens` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
--> statement-breakpoint
CREATE TABLE `watch_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text,
	`alias_id` integer NOT NULL,
	`tmdb_id` integer,
	`provider` text NOT NULL,
	`external_entry_id` text NOT NULL,
	`watched_at` text,
	`logged_at` text,
	`rating10` integer,
	`liked` integer DEFAULT false NOT NULL,
	`rewatch` integer DEFAULT false NOT NULL,
	`review_text` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`raw` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `source_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alias_id`) REFERENCES `film_aliases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watch_log_entry_uq` ON `watch_log` (`user_id`,`provider`,`external_entry_id`);--> statement-breakpoint
CREATE INDEX `watch_log_user_tmdb_idx` ON `watch_log` (`user_id`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `watch_log_alias_idx` ON `watch_log` (`alias_id`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text,
	`alias_id` integer NOT NULL,
	`tmdb_id` integer,
	`provider` text NOT NULL,
	`added_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `source_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alias_id`) REFERENCES `film_aliases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_user_alias_uq` ON `watchlist` (`user_id`,`alias_id`);--> statement-breakpoint
CREATE INDEX `watchlist_user_tmdb_idx` ON `watchlist` (`user_id`,`tmdb_id`);