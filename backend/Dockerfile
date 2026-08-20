FROM node:22-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
COPY frontend/ ./frontend/
EXPOSE 3001
CMD ["npm","start"]
