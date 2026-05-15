FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy all application files
COPY . .

# Remove sensitive files
RUN rm -f .env

EXPOSE 3000

CMD ["node", "server/index.js"]
