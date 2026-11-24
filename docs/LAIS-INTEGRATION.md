# LAIS ↔ GIS transaction integration

## Decision

Use a separate, non-spatial transaction table in the existing ArcGIS Enterprise GIS environment. Do not add LAIS transaction columns to the parcel polygon layer and do not give LAIS direct database or unrestricted Feature Service access.

The existing parcel polygon layer stores the UPI in its `name` field. The integration API must map the external `UPI` value to that field when it checks that a parcel exists.

## Responsibilities

- **LAIS** submits `UPI`, `Transaction_ID`, `Transaction_Status`, and `Transaction_Date`.
- **GIS Transaction Integration API** authenticates LAIS independently of Portal user sessions, validates the payload, checks the parcel UPI and duplicate transaction ID, writes accepted transaction records, and returns the API-controlled `case` result.
- **Web editing application** reads eligible transaction records and creates the named ArcGIS version through the existing signed-in user's VersionManagementService session and permissions.
- **ArcGIS Enterprise** remains the system of record for parcel geometry and transaction records.

LAIS must not send or choose `case`. The API computes it. A failed validation returns `case: "No"` and field-specific errors; no version may be created. A successful validation writes a record with `case: "Yes"` and makes it eligible for the web application's version workflow.

## Transaction table proposal

Publish a non-spatial table in the existing Parcel Fabric Feature Service (or an approved companion Feature Service in the same ArcGIS Enterprise deployment). The exact table ID and actual field names must be taken from the live Feature Service metadata before enabling writes.

| Field | Suggested type | Purpose |
| --- | --- | --- |
| `UPI` | String | Parcel identifier received from LAIS |
| `Transaction_ID` | String | LAIS transaction identifier; unique |
| `Transaction_Status` | String | Status supplied by LAIS |
| `Transaction_Date` | Date | Transaction date supplied by LAIS |
| `case` | String (length 3) | API-controlled `Yes` or `No` validation result |
| `validation_message` | String | Validation result details for audit and support |
| `version_name` | String | Named version created by the web application |
| `version_status` | String | Workflow state, e.g. Pending / Created / Failed |
| `created_at` | Date | API record creation time |

Use a GlobalID/ObjectID primary identifier supplied by ArcGIS. Enforce uniqueness for `Transaction_ID` if the service/database supports it. Keep transaction records as history; do not overwrite prior transactions when a parcel is processed again.

The table should be related to parcels by UPI at the application level. Do not create an ArcGIS relationship class until the parcel key's uniqueness and the service's relationship/branch-versioning constraints have been verified.

## Proposed LAIS API contract

### Submit a transaction

`POST /api/lais/transactions`

Authentication: a dedicated LAIS credential (prefer OAuth 2.0 client credentials or mTLS; a high-entropy API key may be used for a controlled initial deployment). This is separate from the Portal bearer-token middleware used by the browser application.

Request body:

```json
{
  "UPI": "1/02/13/02/1001",
  "Transaction_ID": "LAIS-SUB-2026-00125",
  "Transaction_Status": "COMPLETED",
  "Transaction_Date": "2026-11-24T08:30:00+02:00"
}
```

The request deliberately excludes `case`: the API owns that decision.

Validation should include:
1. All four submitted fields are present and non-empty.
2. UPI follows the existing Rwanda UPI format and matches an existing parcel's `name` value.
3. Transaction_ID has not already been recorded (retries should be idempotent where the payload is identical; conflicting reuse must be rejected).
4. Transaction_Status is accepted by the business-approved status list. Until LAIS and GIS agree that list, only presence/type can be enforced.
5. Transaction_Date is a valid, unambiguous date/time and is normalized consistently before storage.

Validation failure response (HTTP 400 or 422):

```json
{
  "success": false,
  "case": "No",
  "message": "Validation failed",
  "errors": [
    {
      "field": "Transaction_Date",
      "code": "REQUIRED_FIELD",
      "message": "Transaction_Date is required."
    }
  ]
}
```

Validation success response (HTTP 201):

```json
{
  "success": true,
  "case": "Yes",
  "message": "Transaction validated and recorded.",
  "data": {
    "UPI": "1/02/13/02/1001",
    "Transaction_ID": "LAIS-SUB-2026-00125",
    "Transaction_Status": "COMPLETED",
    "Transaction_Date": "2026-11-24T08:30:00+02:00",
    "case": "Yes",
    "version_status": "Pending"
  }
}
```

A failed validation is returned with `case: "No"`; it must never create a version. Whether rejected attempts themselves should also be persisted as table rows is a separate audit-retention decision and must not be assumed, because some submitted fields may be missing or invalid.

### Read eligible transactions

The web application needs a Portal-authenticated endpoint to list or retrieve records where `case = "Yes"` and `version_status = "Pending"`. The application then creates the version using the existing `versionSession.createVersion(name, access, description)` method and updates the transaction row with the created version name/status. LAIS credentials must not be used to create ArcGIS versions.

## Configuration and deployment gates

Do not enable write operations until all of the following are known and configured:

- Live Feature Service URL, table ID, and exact table field names/types.
- Parcel layer ID and confirmation that its UPI field is `name` in the deployed service.
- A least-privilege ArcGIS service identity/token strategy for server-side table edits. Do not use a database owner account or expose ArcGIS credentials/tokens to LAIS.
- A dedicated LAIS client authentication mechanism and secret provisioning outside source control.
- The authoritative set of allowed `Transaction_Status` values and date/time interpretation (timezone/date-only versus timestamp).
- The policy for persisting rejected attempts and the web application's version naming/creation trigger.

The existing `server/src/scripts/inspectServices.ts` script can produce the live service metadata report. Run it in the deployment environment with a least-privilege named Portal account and review the table list/fields before setting the table ID. Never commit `server/.env` or generated credentials.
