import { JsonSchemaCommand } from "..";
import * as jsonSchema from "json-schema";

/** Collection of fixes for the json schema dictionary generated by parsing redis-doc's command.json */
export const fixupSchema = (schema: Record<string, JsonSchemaCommand>) => {
    const clone: typeof schema = JSON.parse(JSON.stringify(schema));

    fixSetEnum(clone);
    fixArrayRepliesManually(clone);
    fixBulkStringRepliesManually(clone);
    fixScoreValues(clone);

    return clone;
};

/** https://github.com/redis/redis-doc/pull/1232 */
function fixSetEnum(schema: Record<string, JsonSchemaCommand>) {
    /**
     * was:
     * {
        "name": "expiration",
        "type": "enum",
        "enum": [
          "EX seconds",
          "PX milliseconds",
          "KEEPTTL"
        ],
        "optional": true
      },

      now:
      
      {
        "name": "expiration",
        "type": "enum",
        "enum": [
          "EX seconds",
          "PX milliseconds",
          "EXAT timestamp",
          "PXAT milliseconds-timestamp",
          "KEEPTTL"
        ],
        "optional": true
      },
     */
    const badSetArg = schema.SET.arguments.find(
        a =>
            a.name === "expiration" &&
            a.schema.enum!.join(",") === "EX seconds,PX milliseconds,EXAT timestamp,PXAT milliseconds-timestamp,KEEPTTL"
    )!;
    // this will throw if the SET schema has changed (see `!` on line above). If that's the case, maybe the
    // issue was fixed and this can be deleted?
    badSetArg.schema = {
        anyOf: [
            {
                type: "array",
                items: [
                    // format: `["EX", 123]` or `["PX", 123]` or `["EXAT", 1631875021]` or `["PXAT", 1631875021160]`
                    { type: "string", enum: ["EX", "PX", "EXAT", "PXAT"] },
                    { type: "number" },
                ],
            },
            {
                type: "string",
                const: "KEEPTTL",
            },
        ],
    };
}

/**
 * https://github.com/redis/redis-doc/pull/1232 - it'd be _great_ if redis-doc told us in a meaningful way
 * what the various command replies formats will be. Until then, this applies manually-maintained return
 * types to a few of the @array-reply commands, which often end up as `unknown`.
 */
export function fixArrayRepliesManually(schema: Record<string, JsonSchemaCommand>) {
    /**
     * Dictionary of manual "array" schemas. Will likely be added/edited to over time.
     */
    const manuallyFixedUp: Record<string, jsonSchema.JSONSchema7 & { type: "array" }> = {
        GEOHASH: { type: "array", items: { type: "string" } },
        KEYS: { type: "array", items: { type: "string" } },
        HKEYS: { type: "array", items: { type: "string" } },
        HMGET: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
        HVALS: { type: "array", items: { type: "string" } },
        LRANGE: { type: "array", items: { type: "string" } },
        MGET: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
        SDIFF: { type: "array", items: { type: "string" } },
        SINTER: { type: "array", items: { type: "string" } },
        SMEMBERS: { type: "array", items: { type: "string" } },
        SUNION: { type: "array", items: { type: "string" } },
        TIME: { type: "array", items: { type: "number" } },
        ZPOPMAX: { type: "array", items: { type: "string" } },
        ZPOPMIN: { type: "array", items: { type: "string" } },
        ZRANGE: { type: "array", items: { type: "string" } },
        ZREVRANGE: { type: "array", items: { type: "string" } },
        ZRANGEBYLEX: { type: "array", items: { type: "string" } },
        ZREVRANGEBYLEX: { type: "array", items: { type: "string" } },
        ZRANGEBYSCORE: { type: "array", items: { type: "string" } },
        ZREVRANGEBYSCORE: { type: "array", items: { type: "string" } },
    };

    Object.entries(schema).forEach(([name, command]) => {
        if (name in manuallyFixedUp) {
            command.return = manuallyFixedUp[name];
        } else if (command.return.type === "array" && !command.return.items && process.env.FIND_GENERIC_ARRAYS) {
            console.warn(`${name} has a generic array return type`);
        }
    });
}

function fixBulkStringRepliesManually(schema: Record<string, JsonSchemaCommand>) {
    /**
     * Catch-all bucket for patches to the generated schema. A lot of commands specify their return type
     * as `@bulk-string-reply` so a few fixes for those might end up here.
     */
    const manuallyFixedUp: Record<string, jsonSchema.JSONSchema7> = {
        SPOP: { anyOf: [{ type: "null" }, { type: "string" }, { type: "array", items: { type: "string" } }] },
        SCAN: {
            type: "array",
            items: [
                { title: "cursor", type: "string" },
                { title: "values", type: "array", items: { type: "string" } },
            ],
        },
    };
    manuallyFixedUp.SSCAN = manuallyFixedUp.SCAN;
    manuallyFixedUp.HSCAN = manuallyFixedUp.SCAN;
    manuallyFixedUp.ZSCAN = manuallyFixedUp.SCAN;

    Object.entries(schema).forEach(([name, command]) => {
        if (name in manuallyFixedUp) {
            command.return = manuallyFixedUp[name];
        }
    });
}

/**
 * Some commands have "score" values which are listed as doubles, but can actually take values like `-inf`, `+inf` and `(123`
 * This modifies those arguments' schemas to match reality.
 * See https://github.com/redis/redis-doc/issues/1420 and https://github.com/mmkal/handy-redis/issues/30
 */
export function fixScoreValues(schema: Record<string, JsonSchemaCommand>) {
    const intervalScoreArgs = [
        { command: "ZRANGEBYSCORE", argument: "min" },
        { command: "ZRANGEBYSCORE", argument: "max" },
        { command: "ZREVRANGEBYSCORE", argument: "min" },
        { command: "ZREVRANGEBYSCORE", argument: "max" },
        { command: "ZREMRANGEBYSCORE", argument: "min" },
        { command: "ZREMRANGEBYSCORE", argument: "max" },
        { command: "ZCOUNT", argument: "min" },
        { command: "ZCOUNT", argument: "max" },
    ];

    intervalScoreArgs.forEach(({ command, argument }) => {
        const existing = schema[command]?.arguments.find(a => a.name === argument && a.schema.type === "number");
        if (!existing) {
            throw Error(`Expected command ${command} to have number argument called ${argument}`);
        }
        existing.schema = {
            anyOf: [
                {
                    type: "number",
                },
                {
                    type: "string",
                    enum: ["-inf", "+inf"],
                },
                {
                    type: "string",
                    pattern: "^\\(\\d+(\\.\\d+)?$",
                },
            ],
        };
    });
}
