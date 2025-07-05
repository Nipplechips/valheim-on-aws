terraform {
  required_version = "~> 1.0"

  backend "s3" {
    bucket = "valheim-aroundtown-state-files"
    key    = "valheim-server/prod/terraform.tfstate"
    region = "eu-west-1"
    profile = "games"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.25"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  profile = "games"

  default_tags {
  tags = {
     Environment = "Prod"
     Owner       = "Finch"
     Project     = "Valheim"
   }
  }
}
