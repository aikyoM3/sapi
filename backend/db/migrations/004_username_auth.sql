ALTER TABLE users RENAME COLUMN email TO username;
ALTER INDEX users_email_lower_unique RENAME TO users_username_lower_unique;
