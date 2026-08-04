"""Lambda handler path handling — no DB needed (the root route is static).
Verifies the CloudFront /api prefix is stripped while direct execute-api
paths pass through."""

import json

from mtg_api.lambda_handler import handler


class FakeContext:
    function_name = "mtg-api"
    memory_limit_in_mb = 512
    invoked_function_arn = "arn:aws:lambda:us-west-2:0:function:mtg-api"
    aws_request_id = "test"


def apigw_v2_event(path):
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {"host": "example.execute-api.us-west-2.amazonaws.com"},
        "requestContext": {
            "accountId": "0",
            "apiId": "example",
            "domainName": "example.execute-api.us-west-2.amazonaws.com",
            "domainPrefix": "example",
            "http": {
                "method": "GET",
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
                "userAgent": "pytest",
            },
            "requestId": "test",
            "routeKey": "$default",
            "stage": "$default",
            "time": "01/Jan/2026:00:00:00 +0000",
            "timeEpoch": 0,
        },
        "isBase64Encoded": False,
    }


def test_direct_root_path():
    resp = handler(apigw_v2_event("/"), FakeContext())
    assert resp["statusCode"] == 200
    assert "attribution" in json.loads(resp["body"])


def test_cloudfront_api_prefix_is_stripped():
    resp = handler(apigw_v2_event("/api/"), FakeContext())
    assert resp["statusCode"] == 200
    assert "attribution" in json.loads(resp["body"])


def test_unknown_path_404s_not_500s():
    resp = handler(apigw_v2_event("/api/nope"), FakeContext())
    assert resp["statusCode"] == 404
