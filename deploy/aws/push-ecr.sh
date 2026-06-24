#!/usr/bin/env bash
# Build the Reins server image and push it to ECR using the `mdd` AWS profile.
#
#   ./deploy/aws/push-ecr.sh
#
# Env (override as needed):
#   AWS_PROFILE  (default: mdd)
#   AWS_REGION   (default: us-east-1)
#   REPO         (default: reins-server)
#   TAG          (default: latest)
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-mdd}"
AWS_REGION="${AWS_REGION:-us-east-1}"
REPO="${REPO:-reins-server}"
TAG="${TAG:-latest}"

ACCOUNT_ID="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${REPO}:${TAG}"

echo "→ ensuring ECR repo ${REPO} exists"
aws ecr describe-repositories --repository-names "$REPO" --profile "$AWS_PROFILE" --region "$AWS_REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --profile "$AWS_PROFILE" --region "$AWS_REGION" >/dev/null

echo "→ logging in to ${REGISTRY}"
aws ecr get-login-password --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "→ building (linux/amd64) and pushing ${IMAGE}"
docker buildx build --platform linux/amd64 -t "$IMAGE" --push ./server

echo "✓ pushed ${IMAGE}"
echo "  Use this image URI in App Runner / ECS / Lightsail."
