"""Request/response models — the public shape of the API. Kept independent
of the DB row shape so schema changes stay deliberate. Money is always
integer cents; None means unknown, never 0."""

import datetime
import uuid
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)

Condition = Literal["NM", "LP", "MP", "HP", "DMG"]
Finish = Literal["nonfoil", "foil", "etched"]
Channel = Literal["pos", "web", "ebay", "manapool", "cardtrader", "tcgplayer", "adjustment"]
# Part of the inventory grain. Only MTG has a catalog (mtg-api) today; adding
# a game is a Literal + CHECK change (migrations/0004), not a grain change.
Game = Literal["mtg"]

# Postgres `integer` bound — larger values 422 here instead of erroring in SQL.
INT32_MAX = 2**31 - 1
REASON_MAX = 500


def no_nul(v: str) -> str:
    # Postgres text can't hold NUL; reject it here instead of a 500 from SQL.
    if "\x00" in v:
        raise ValueError("must not contain NUL bytes")
    return v


def _lower_strip(v: object) -> object:
    return v.strip().lower() if isinstance(v, str) else v


# Free text that lands in the ledger/audit: trimmed, non-blank, bounded.
Reason = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=REASON_MAX),
    AfterValidator(no_nul),
]
# Scryfall-style language code ("en", "ja", "zhs"), case-normalised first so
# "EN" and "en" can't become two grains. Mirrored by a CHECK in 0004.
Lang = Annotated[str, BeforeValidator(_lower_strip), StringConstraints(pattern=r"^[a-z]{2,3}$")]


class InventoryItem(BaseModel):
    id: uuid.UUID
    location_id: uuid.UUID
    printing_id: uuid.UUID
    game: str
    condition: Condition
    finish: Finish
    lang: str
    qty: int
    price_cents: int | None = None
    updated_at: datetime.datetime


class InventoryPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[InventoryItem]


class InventoryAdjust(BaseModel):
    """Apply `delta` to the item at this grain, creating it (qty 0, unpriced)
    if it doesn't exist yet."""

    location_id: uuid.UUID
    printing_id: uuid.UUID
    game: Game = "mtg"
    condition: Condition
    finish: Finish
    lang: Lang = "en"
    delta: int = Field(
        ..., strict=True, ge=-INT32_MAX, le=INT32_MAX, description="Signed qty change; never 0"
    )
    reason: Reason
    channel: Channel = "adjustment"
    # Optional: set the shelf price in the same transaction (e.g. when
    # receiving stock). Omitted leaves the price as is; it is recorded in
    # the adjust's audit row, never in the quantity ledger.
    price_cents: int | None = Field(None, strict=True, ge=0, le=INT32_MAX)

    @field_validator("delta")
    @classmethod
    def _nonzero(cls, v: int) -> int:
        if v == 0:
            raise ValueError("delta must not be 0")
        return v


class InventoryAdjustResult(BaseModel):
    item: InventoryItem
    ledger_id: uuid.UUID


class CreditBalance(BaseModel):
    customer_id: uuid.UUID
    balance_cents: int


class CreditChange(BaseModel):
    # strict: a "12.00" string is almost certainly dollars — refuse to coerce it to 12 cents.
    amount_cents: int = Field(..., strict=True, gt=0, le=INT32_MAX, description="Integer cents")
    reason: Reason


class InventoryPriceUpdate(BaseModel):
    """Set (or clear, with null) an item's shelf price. Price changes are
    audit-logged; the ledger only ever records quantity."""

    price_cents: int | None = Field(..., strict=True, ge=0, le=INT32_MAX)


# --- pricing -----------------------------------------------------------------

BasisPoints = Annotated[int, Field(strict=True, ge=0, le=100_000)]


class PriceRule(BaseModel):
    """Condition multipliers in basis points (10000 = 100%), a floor, and a
    round-up step. See migrations/0005_price_rule.sql for the formula."""

    nm_bp: BasisPoints
    lp_bp: BasisPoints
    mp_bp: BasisPoints
    hp_bp: BasisPoints
    dmg_bp: BasisPoints
    min_price_cents: int = Field(..., strict=True, ge=0, le=INT32_MAX)
    round_up_to_cents: int = Field(..., strict=True, ge=1, le=10_000)


class PriceRuleOut(PriceRule):
    is_default: bool
    updated_at: datetime.datetime | None = None


class PriceSuggestion(BaseModel):
    printing_id: uuid.UUID
    finish: Finish
    condition: Condition
    # None when mtg-api has no USD reference for this printing/finish — never 0.
    suggested_cents: int | None
    reference_cents: int | None
    reference_source: str | None
    multiplier_bp: int
    rule: PriceRule
    # Provenance of the reference, straight from mtg-api.
    snapshot_id: str | None
    sku_id: int | None = None
    sku_condition: str | None = None
    sku_lang: str | None = None
    stale: bool | None = None
    attribution: list[str] = []
    note: str | None = None


# --- TCGplayer import ---------------------------------------------------------


class ImportRow(BaseModel):
    row: int  # line number in the CSV (header is line 1)
    status: Literal["matched", "unmatched", "skipped"]
    reason: str | None = None
    product_name: str | None = None
    set_name: str | None = None
    set_code: str | None = None
    number: str | None = None
    condition: Condition | None = None
    finish: Finish | None = None
    lang: str | None = None
    qty: int | None = None
    price_cents: int | None = None
    printing_id: uuid.UUID | None = None


class ImportChange(BaseModel):
    """One inventory grain the import touches (rows at the same grain are
    summed). `delta` is what the ledger records; 0 means qty is already right."""

    printing_id: uuid.UUID
    condition: Condition
    finish: Finish
    lang: str
    rows: list[int]
    current_qty: int
    target_qty: int
    delta: int
    current_price_cents: int | None
    price_cents: int | None
    item_id: uuid.UUID | None = None


class ImportTotals(BaseModel):
    rows: int
    matched: int
    unmatched: int
    skipped: int
    grains: int
    changed: int
    qty_delta: int


class ImportResult(BaseModel):
    dry_run: bool
    location_id: uuid.UUID
    snapshot_id: str | None
    totals: ImportTotals
    changes: list[ImportChange]
    rows: list[ImportRow]


# --- storefront ----------------------------------------------------------------


def _blank_to_none(v: object) -> object:
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


Slug = Annotated[
    str, BeforeValidator(_lower_strip), StringConstraints(pattern=r"^[a-z0-9-]{3,40}$")
]
DisplayName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(no_nul),
]
PolicyText = Annotated[
    Annotated[str, StringConstraints(max_length=4000), AfterValidator(no_nul)] | None,
    BeforeValidator(_blank_to_none),
]
PickupText = Annotated[
    Annotated[str, StringConstraints(max_length=1000), AfterValidator(no_nul)] | None,
    BeforeValidator(_blank_to_none),
]
CustomDomain = Annotated[
    Annotated[str, StringConstraints(pattern=r"^[a-z0-9.-]{3,253}$")] | None,
    BeforeValidator(lambda v: _lower_strip(_blank_to_none(v))),
]


class StorefrontSettings(BaseModel):
    """The tenant's web storefront. See migrations/0006_storefront.sql for
    the holdback rule (web_available)."""

    slug: Slug
    display_name: DisplayName
    published: bool = False
    location_id: uuid.UUID
    holdback_copies: int = Field(0, strict=True, ge=0, le=INT32_MAX)
    holdback_pct: int = Field(0, strict=True, ge=0, le=100)
    reservation_hours: int = Field(48, strict=True, ge=1, le=336)
    custom_domain: CustomDomain = None
    policy_text: PolicyText = None
    pickup_text: PickupText = None


class StorefrontSettingsOut(StorefrontSettings):
    updated_at: datetime.datetime


# --- public storefront ------------------------------------------------------------

ORDER_LINES_MAX = 40
LINE_QTY_MAX = 20


class PickupLocation(BaseModel):
    id: uuid.UUID
    name: str


class StorefrontInfo(BaseModel):
    slug: str
    display_name: str
    pickup_location: PickupLocation
    pickup_text: str | None
    policy_text: str | None
    reservation_hours: int


class StorefrontOffer(BaseModel):
    inventory_item_id: uuid.UUID
    printing_id: uuid.UUID
    game: str
    condition: Condition
    finish: Finish
    lang: str
    price_cents: int
    # Web-sellable quantity after the store's holdback — never the shelf qty.
    available: int


class StorefrontOffers(BaseModel):
    offers: list[StorefrontOffer]


class CartLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inventory_item_id: uuid.UUID
    qty: int = Field(..., strict=True, ge=1, le=LINE_QTY_MAX)
    # Optional: the price the customer saw. If live differs, the line is
    # flagged price_changed (quote) or rejected (order) instead of silently
    # charging a different price.
    unit_price_cents: int | None = Field(None, strict=True, ge=0, le=INT32_MAX)


def _unique_items(lines: list[CartLine]) -> list[CartLine]:
    ids = [line.inventory_item_id for line in lines]
    if len(ids) != len(set(ids)):
        raise ValueError("each inventory_item_id may appear once; combine quantities")
    return lines


CartLines = Annotated[
    list[CartLine],
    Field(min_length=1, max_length=ORDER_LINES_MAX),
    AfterValidator(_unique_items),
]


class CartQuoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lines: CartLines


LineStatus = Literal["ok", "not_found", "not_priced", "insufficient", "price_changed"]


class CartLineResult(BaseModel):
    inventory_item_id: uuid.UUID
    qty: int
    status: LineStatus
    available: int
    unit_price_cents: int | None
    line_total_cents: int | None
    printing_id: uuid.UUID | None
    condition: Condition | None
    finish: Finish | None
    lang: str | None


class CartQuote(BaseModel):
    ok: bool
    total_cents: int
    lines: list[CartLineResult]


Email = Annotated[
    str,
    BeforeValidator(_lower_strip),
    StringConstraints(max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$"),
    AfterValidator(no_nul),
]
CustomerName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(no_nul),
]
Phone = Annotated[
    Annotated[str, StringConstraints(pattern=r"^[0-9+()\-. ]{4,40}$")] | None,
    BeforeValidator(_blank_to_none),
]
IdempotencyKey = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{8,100}$")]


class Customer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: CustomerName
    email: Email
    phone: Phone = None


class WebOrderIn(BaseModel):
    """Reserve for in-store pickup. No payment is taken."""

    model_config = ConfigDict(extra="forbid")

    idempotency_key: IdempotencyKey
    customer: Customer
    lines: CartLines


WebOrderStatus = Literal["reserved", "picked_up", "cancelled", "expired"]


class WebOrderLine(BaseModel):
    inventory_item_id: uuid.UUID
    printing_id: uuid.UUID
    game: str
    condition: Condition
    finish: Finish
    lang: str
    name: str | None
    unit_price_cents: int
    qty: int


class WebOrderPublic(BaseModel):
    """What the customer's confirmation page sees."""

    id: uuid.UUID
    status: WebOrderStatus
    pickup_code: str
    customer_name: str
    total_cents: int
    expires_at: datetime.datetime
    created_at: datetime.datetime
    store: StorefrontInfo
    lines: list[WebOrderLine]


class WebOrderStaff(BaseModel):
    id: uuid.UUID
    location_id: uuid.UUID
    status: WebOrderStatus
    pickup_code: str
    customer_name: str
    customer_email: str
    customer_phone: str | None
    total_cents: int
    expires_at: datetime.datetime
    created_at: datetime.datetime
    updated_at: datetime.datetime
    lines: list[WebOrderLine]


class WebOrderPage(BaseModel):
    total: int
    page: int
    page_size: int
    orders: list[WebOrderStaff]


# --- auth: me, stores, staff, invites, roles ----------------------------------

StoreName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(no_nul),
]
RoleKey = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,39}$")]
MemberStatus = Literal["active", "disabled"]


class MeUser(BaseModel):
    id: uuid.UUID
    email: str | None
    display_name: str | None


class MyStore(BaseModel):
    tenant_id: uuid.UUID
    name: str
    role: str
    role_name: str


class Me(BaseModel):
    user: MeUser
    stores: list[MyStore]


class StoreCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: StoreName
    location_name: StoreName = "Main"


class Role(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    is_system: bool
    perms: list[str]


class StaffMember(BaseModel):
    user_id: uuid.UUID
    email: str | None
    display_name: str | None
    role: str
    role_name: str
    status: MemberStatus
    location_id: uuid.UUID | None
    invited_by: uuid.UUID | None
    created_at: datetime.datetime


class StaffUpdate(BaseModel):
    """Change a member's role and/or status. Omitted fields stay as they are."""

    model_config = ConfigDict(extra="forbid")

    role: RoleKey | None = None
    status: MemberStatus | None = None


class InviteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    role: RoleKey


InviteStatus = Literal["pending", "accepted", "revoked", "expired"]


class Invite(BaseModel):
    id: uuid.UUID
    email: str
    role: str
    status: InviteStatus
    expires_at: datetime.datetime
    invited_by: uuid.UUID
    accepted_by: uuid.UUID | None
    created_at: datetime.datetime


class InviteAccept(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: Annotated[str, StringConstraints(min_length=16, max_length=200)]


class InviteAccepted(BaseModel):
    tenant_id: uuid.UUID
    role: str


class DevLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email


class DevToken(BaseModel):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"
    expires_in: int
    sub: str


# --- registers, PINs, approvals (A3) -------------------------------------------

Pin = Annotated[str, StringConstraints(min_length=1, max_length=32)]
RegisterName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=60),
    AfterValidator(no_nul),
]


class PinSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pin: Pin


class Register(BaseModel):
    id: uuid.UUID
    location_id: uuid.UUID
    name: str
    created_at: datetime.datetime


class RegisterCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    location_id: uuid.UUID
    name: RegisterName


DeviceStatus = Literal["active", "revoked"]


class RegisterDevice(BaseModel):
    id: uuid.UUID
    register_id: uuid.UUID
    register_name: str
    status: DeviceStatus
    enrolled_by: uuid.UUID
    enrolled_at: datetime.datetime
    last_seen_at: datetime.datetime | None
    revoked_at: datetime.datetime | None


class DeviceEnrolled(BaseModel):
    """The device secret is shown once; the register stores it and sends
    `Authorization: Device <device_secret>` from then on."""

    device: RegisterDevice
    device_secret: str


class RegisterStaff(BaseModel):
    user_id: uuid.UUID
    name: str
    role: str


class RegisterSignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: uuid.UUID
    pin: Pin


class RegisterSessionOut(BaseModel):
    """Send `X-Register-Session: <session_token>` (with the device
    credential) on every request until it expires, idles out or is
    signed out."""

    session_id: uuid.UUID
    session_token: str
    user_id: uuid.UUID
    name: str
    role: str
    perms: list[str]
    expires_at: datetime.datetime
    idle_timeout_seconds: int


class ApprovalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    perm: str
    payload_hash: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    amount_cents: int | None = Field(None, strict=True, ge=0)
    approver_user_id: uuid.UUID
    pin: Pin


class ApprovalOut(BaseModel):
    approval_id: uuid.UUID
    perm: str
    amount_cents: int | None
    approved_by: uuid.UUID
    expires_at: datetime.datetime


class CreditAdjust(BaseModel):
    """A signed correction to a balance (not a sale, not an issue)."""

    model_config = ConfigDict(extra="forbid")

    delta_cents: int = Field(..., strict=True, ge=-INT32_MAX, le=INT32_MAX)
    reason: Reason

    @field_validator("delta_cents")
    @classmethod
    def _nonzero(cls, v: int) -> int:
        if v == 0:
            raise ValueError("delta_cents must not be 0")
        return v
