# Vanitum Node MySQL Test

Small Express application for testing a Vanitum-managed MySQL database.

## Configuration

Add the following environment variable to the application in Vanitum:

```text
DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DATABASE
```

Do not commit the real connection URL. The internal database hostname is
available to applications running in the same Vanitum account.

The application listens on `PORT`, defaulting to `3000`.

## Endpoints

- `GET /health`: application health
- `GET /mysql/health`: verify the MySQL connection
- `GET /mysql/notes`: create the test table when needed and list notes
- `POST /mysql/notes`: insert a note with JSON such as `{"message":"Hello"}`

Example:

```bash
curl https://YOUR-APP.vanitum.com/mysql/health
curl -X POST https://YOUR-APP.vanitum.com/mysql/notes \
  -H "Content-Type: application/json" \
  -d '{"message":"MySQL is connected"}'
curl https://YOUR-APP.vanitum.com/mysql/notes
```
