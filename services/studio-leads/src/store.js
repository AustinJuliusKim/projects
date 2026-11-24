import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export function createStore({ tableName = process.env.TABLE_NAME, client } = {}) {
  const doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return async function saveLead(lead) {
    const { email, createdAt, updatedAt, ...rest } = lead;
    const names = {};
    const values = { ":now": updatedAt };
    const sets = [];
    let i = 0;
    for (const [k, v] of Object.entries(rest)) {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
      i++;
    }
    sets.push("updatedAt = :now", "createdAt = if_not_exists(createdAt, :now)");
    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { email },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  };
}
