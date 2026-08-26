FROM node:20-alpine
WORKDIR /app
# Deliberately slow layer so tests can cancel mid-BUILDING deterministically.
RUN sleep 15 && echo ok > /tmp/slow
COPY package.json server.js ./
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "server.js"]
