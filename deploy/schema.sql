CREATE DATABASE IF NOT EXISTS debt_demo CHARACTER SET utf8mb4;
USE debt_demo;
CREATE TABLE IF NOT EXISTS authorized_assets (
  id INT UNSIGNED PRIMARY KEY,
  owner_key VARCHAR(48) NOT NULL,
  agency VARCHAR(80) NOT NULL,
  origin VARCHAR(80) NOT NULL,
  loan_date DATE NOT NULL,
  principal INT UNSIGNED NOT NULL,
  balance INT UNSIGNED NOT NULL,
  as_of DATE NOT NULL,
  authority_valid BOOLEAN NOT NULL,
  KEY assets_owner (owner_key, authority_valid)
);
CREATE TABLE IF NOT EXISTS transfer_notices (
  id INT UNSIGNED PRIMARY KEY,
  lookup_key VARCHAR(48) NOT NULL,
  origin VARCHAR(80) NOT NULL,
  receiver VARCHAR(80) NOT NULL,
  notice_date DATE NOT NULL,
  amount INT UNSIGNED NOT NULL,
  proof_kind ENUM('verified_history','masked_candidate') NOT NULL,
  source_ref VARCHAR(80) NOT NULL,
  KEY notices_lookup (lookup_key, proof_kind)
);
CREATE TABLE IF NOT EXISTS query_events (
  id CHAR(36) PRIMARY KEY,
  owner_key VARCHAR(48) NOT NULL,
  authorization_version VARCHAR(24) NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY query_owner (owner_key,created_at)
);
CREATE TABLE IF NOT EXISTS unlocks (
  owner_key VARCHAR(48) NOT NULL,
  notice_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_key, notice_id)
);
CREATE TABLE IF NOT EXISTS callback_requests (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  owner_key VARCHAR(48) NOT NULL,
  query_id CHAR(36) NOT NULL,
  time_window VARCHAR(30) NOT NULL,
  state ENUM('pending','replied','withdrawn') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY callback_once (query_id),
  KEY callback_owner (owner_key,created_at)
);
CREATE TABLE IF NOT EXISTS synthetic_notice_candidates (
  source_ref VARCHAR(32) PRIMARY KEY,
  sample_name VARCHAR(24) NOT NULL,
  tail4 CHAR(4) NOT NULL,
  notice_date DATE NOT NULL,
  source_page SMALLINT UNSIGNED NOT NULL,
  KEY candidate_pair (sample_name, tail4)
);
