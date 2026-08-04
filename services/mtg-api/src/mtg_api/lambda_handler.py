from mangum import Mangum

from mtg_api.app import create_app

handler = Mangum(create_app(), lifespan="off")
