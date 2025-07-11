variable "admins" {
  type        = map(any)
  default     = { "finch" = "76561198082848016", }
  description = "List of AWS users/Valheim server admins (use their SteamID)"
}

variable "aws_region" {
  type        = string
  description = "The AWS region to create the Valheim server"
  default = "eu-west-2"
}

variable "aws_account_id" {
  type = string
  description = "AWS Account ID"
  default = "557690593857"
}

variable "domain" {
  type        = string
  default     = ""
  description = "Domain name used to create a static monitoring URL"
}

variable "instance_type" {
  type        = string
  default     = "t3a.medium"
  description = "AWS EC2 instance type to run the server on (t3a.medium is the minimum size)"
}

variable "pgp_key" {
  type        = string
  default     = "keybase:finch"
  description = "The base64 encoded PGP public key to encrypt AWS user passwords with. Can use keybase syntax, e.g., 'keybase:username'."
}

variable "purpose" {
  type        = string
  default     = "prod"
  description = "The purpose of the deployment"
}

variable "s3_lifecycle_expiration" {
  type        = string
  default     = "90"
  description = "The number of days to keep files (backups) in the S3 bucket before deletion"
}

variable "server_name" {
  type        = string
  description = "The server name"
  default = "valheimuniverse"
}

variable "server_password" {
  type        = string
  description = "The server password"
  default = "hello123"
}

variable "sns_email" {
  type        = string
  description = "The email address to send alerts to"
  default = "david.finch.bournemouth@gmail.com"
}

variable "unique_id" {
  type        = string
  default     = ""
  description = "The ID of the deployment (used for tests)"
}

variable "world_name" {
  type        = string
  description = "The Valheim world name"
  default = "aroundtown"
}

variable "discord_app_public_key" {
  type        = string
  description = "The discord bot public key"
  default = "xxx"
}
