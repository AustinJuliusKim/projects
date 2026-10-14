"""ECB euro reference rate, frozen into each snapshot so EUR history stays
reproducible. Reported alongside prices; never used to blend currencies."""

import xml.etree.ElementTree as ET
from datetime import date
from decimal import Decimal

ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"


def parse_ecb_usd(xml_text: str) -> tuple[Decimal, date]:
    """(USD per EUR, rate date) from the ECB daily reference XML."""
    root = ET.fromstring(xml_text)
    for el in root.iter():
        if el.tag.endswith("Cube") and el.get("time"):
            day = date.fromisoformat(el.get("time"))
            for rate in el:
                if rate.get("currency") == "USD":
                    return Decimal(rate.get("rate")), day
    raise ValueError("ECB daily XML has no USD rate")
