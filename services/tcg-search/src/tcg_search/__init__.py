"""tcg_search: OpenSearch-backed card search for the TCG POS storefront.

Public API for other packages (tcg-pos-api's listings indexer and storefront
routes) — see README.md "Public API":

  tcg_search.client.OpenSearch                  httpx client
  tcg_search.mappings.catalog_index_body()      index settings + mappings
  tcg_search.mappings.listings_index_body()
  tcg_search.docs.card_fields(card_row, ...)    shared card fields for docs
  tcg_search.docs.listing_doc(...)              one listings doc
  tcg_search.query.build_search(req, ...)       request -> OpenSearch body
"""
