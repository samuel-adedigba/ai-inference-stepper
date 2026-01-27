

### `packages/stepper/src/ci/deploy.sh

#!/bin/bash
set -e

echo "🚀 Deploying Stepper Service"

# Build Docker image
echo "📦 Building Docker image..."
docker build -t commitdiary-stepper:latest .

# Tag for registry (example)
# docker tag commitdiary-stepper:latest registry.example.com/commitdiary-stepper:latest

# Push to registry (example)
# docker push registry.example.com/commitdiary-stepper:latest

echo "✅ Build complete"

# Example deployment commands (adjust for your platform)
# For Railway:
# railway up

# For Render:
# render deploy

# For Kubernetes:
# kubectl apply -f k8s/deployment.yml

echo "📋 Next steps:"
echo "1. Push image to your container registry"
echo "2. Update deployment configuration with new image"
echo "3. Apply deployment to your cluster/platform"
echo "4. Verify with: curl https://your-domain.com/health"
