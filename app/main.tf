module "main" {
  source = "../module"
  admins                  = var.admins
  aws_region              = var.aws_region
  aws_account_id          = var.aws_account_id
  domain                  = var.domain
  instance_type           = var.instance_type
  pgp_key                 = var.pgp_key
  purpose                 = var.purpose
  s3_lifecycle_expiration = var.s3_lifecycle_expiration
  server_name             = var.server_name
  server_password         = var.server_password
  sns_email               = var.sns_email
  unique_id               = var.unique_id
  world_name              = var.world_name
  discord_app_public_key  = var.discord_app_public_key
}
