Pre-requisites: kind, helm

kind create cluster --config kind-config.yaml

kubectl create ns ingress-nginx

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx

helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx

Wait until Ready, verify with:

kubectl -n ingress-nginx get pods
kubectl -n ingress-nginx get svc ingress-nginx-controller

kubectl apply -f k8s/namespace.yaml

kubectl apply -f k8s/mongo.yaml \
              -f k8s/auth.yaml \
              -f k8s/chat.yaml \
              -f k8s/frontend.yaml \
              -f k8s/ingress-api.yaml \
              -f k8s/ingress-frontend.yaml

Wait until Ready, verify with:
kubectl -n chatapp get pods,svc,ingress,pvc
kubectl -n chatapp rollout status deploy/mongo
kubectl -n chatapp rollout status deploy/auth-service
kubectl -n chatapp rollout status deploy/chat-service
kubectl -n chatapp rollout status deploy/frontend

Open browser in 
http://chatapp.127.0.0.1.nip.io 

if nothing appears do:
Remove your helm install (if present):
        helm uninstall ingress-nginx -n ingress-nginx
    Apply the official kind manifest (this binds 80/443 on the node):
        kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
    Wait until ready:
        kubectl -n ingress-nginx get pods
    Now open (no port-forward): http://chatapp.127.0.0.1.nip.io 

To delete cluster:
kind delete cluster --name chatapp
