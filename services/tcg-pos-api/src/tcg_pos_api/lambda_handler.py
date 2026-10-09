from mangum import Mangum

from tcg_pos_api.app import create_app

# api_gateway_base_path strips the /api prefix a CloudFront /api/* behavior
# would forward (the POS app calls same-origin /api/v1/...); direct
# execute-api requests without the prefix pass through unchanged.
handler = Mangum(create_app(), lifespan="off", api_gateway_base_path="/api")
