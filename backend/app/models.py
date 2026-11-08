"""Database models.

Portable SQLAlchemy 2.0 types only (JSON, String, Float, DateTime), so the schema migrates
to PostgreSQL by changing DATABASE_URL. Every table has created/updated timestamps; tables
holding perishable data also have an expires_at column that every read path filters on.
"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from .database import Base
from .timeutil import utcnow

HAZARD_CATEGORIES = ("ice", "slush", "snow", "unplowed", "blocked_ramp", "other")


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    handle: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    is_anonymous: Mapped[bool] = mapped_column(Boolean, default=True)
    is_seed: Mapped[bool] = mapped_column(Boolean, default=False)  # seeded demo crew member
    points: Mapped[int] = mapped_column(Integer, default=0)
    reports_submitted: Mapped[int] = mapped_column(Integer, default=0)
    hazards_verified: Mapped[int] = mapped_column(Integer, default=0)
    assists_given: Mapped[int] = mapped_column(Integer, default=0)
    needs_accessible_routes: Mapped[bool] = mapped_column(Boolean, default=False)
    accepts_assist_requests: Mapped[bool] = mapped_column(Boolean, default=True)

    contributions: Mapped[list["CrewContribution"]] = relationship(back_populates="user", cascade="all, delete-orphan")

    @validates("handle")
    def _v_handle(self, _, value: str) -> str:
        value = (value or "").strip()
        if not 2 <= len(value) <= 40:
            raise ValueError("handle must be 2-40 characters")
        return value


class ParkingLot(TimestampMixin, Base):
    """Seed configuration for a lot. Capacities are configurable prototype estimates,
    NOT official UB figures."""
    __tablename__ = "parking_lots"
    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), default="commuter")  # commuter | park_and_ride
    description: Mapped[str] = mapped_column(String(200), default="")
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, nullable=False)
    polygon: Mapped[list] = mapped_column(JSON, default=list)  # [[lat,lng],...] approximate outline
    total_capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    total_rows: Mapped[int] = mapped_column(Integer, default=6)
    hourly_profile: Mapped[list] = mapped_column(JSON, default=list)  # 24 occupancy fractions (seed model)
    capacity_is_seed_estimate: Mapped[bool] = mapped_column(Boolean, default=True)

    reports: Mapped[list["ParkingReport"]] = relationship(back_populates="lot", cascade="all, delete-orphan")

    @validates("total_capacity")
    def _v_cap(self, _, v: int) -> int:
        if v <= 0:
            raise ValueError("total_capacity must be positive")
        return v

    @validates("hourly_profile")
    def _v_profile(self, _, v: list) -> list:
        if v and (len(v) != 24 or any(not 0 <= x <= 1 for x in v)):
            raise ValueError("hourly_profile must have 24 values in [0,1]")
        return v


class ParkingReport(TimestampMixin, Base):
    """A crew observation of a lot (from a confirmed scan or a manual report). Expires after 30 min."""
    __tablename__ = "parking_reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    lot_id: Mapped[int] = mapped_column(ForeignKey("parking_lots.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    source: Mapped[str] = mapped_column(String(30), default="crew_scan")  # crew_scan | crew_manual | demo
    occupancy_fraction: Mapped[float] = mapped_column(Float)          # 0..1 of snow-adjusted capacity
    snow_blocked_fraction: Mapped[float] = mapped_column(Float, default=0.0)  # 0..1 of total capacity
    plowed_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unplowed_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.6)
    note: Mapped[str] = mapped_column(String(200), default="")
    user_corrected: Mapped[bool] = mapped_column(Boolean, default=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)

    lot: Mapped[ParkingLot] = relationship(back_populates="reports")
    detection: Mapped["VehicleDetection | None"] = relationship(back_populates="report", uselist=False)

    @validates("occupancy_fraction", "snow_blocked_fraction", "confidence")
    def _v_frac(self, key, v: float) -> float:
        if not 0 <= v <= 1:
            raise ValueError(f"{key} must be within [0,1]")
        return v


class Account(TimestampMixin, Base):
    """A signed-up student (UB email). Linked 1:1 to the User that holds points, sessions and history."""
    __tablename__ = "accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(120), unique=True, index=True)   # lowercase, @buffalo.edu
    password_hash: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(80), default="")
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AuthToken(TimestampMixin, Base):
    """Login session. Only the SHA-256 of the bearer token is stored."""
    __tablename__ = "auth_tokens"
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class EmailCode(TimestampMixin, Base):
    """One-time email verification code (hashed), 15 min lifetime, limited attempts."""
    __tablename__ = "email_codes"
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class ParkingSession(TimestampMixin, Base):
    """A student's car parked in a lot: opened by "I'm parked" or GPS auto-detect, closed on leaving.
    Active sessions adjust the lot's occupied count between crew reports. Expire after 12 h."""
    __tablename__ = "parking_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    lot_id: Mapped[int] = mapped_column(ForeignKey("parking_lots.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")        # manual | auto
    car_lat: Mapped[float | None] = mapped_column(Float, nullable=True)      # where the car is, for "Find my car"
    car_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    end_source: Mapped[str | None] = mapped_column(String(20), nullable=True)  # manual | auto | replaced
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class VehicleDetection(TimestampMixin, Base):
    """Raw output of one image analysis. Only privacy-blurred images are ever stored."""
    __tablename__ = "vehicle_detections"
    id: Mapped[int] = mapped_column(primary_key=True)
    lot_id: Mapped[int] = mapped_column(ForeignKey("parking_lots.id", ondelete="CASCADE"), index=True)
    report_id: Mapped[int | None] = mapped_column(ForeignKey("parking_reports.id", ondelete="SET NULL"), nullable=True)
    provider: Mapped[str] = mapped_column(String(60))
    vehicles_detected: Mapped[int] = mapped_column(Integer)
    estimated_open_spaces: Mapped[int] = mapped_column(Integer)
    snow_blocked_spaces: Mapped[int] = mapped_column(Integer, default=0)
    plowed_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unplowed_rows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[float] = mapped_column(Float)
    space_method: Mapped[str] = mapped_column(String(60))
    boxes: Mapped[list] = mapped_column(JSON, default=list)
    explanation: Mapped[str] = mapped_column(Text, default="")
    raw: Mapped[dict] = mapped_column(JSON, default=dict)
    blurred_image_path: Mapped[str] = mapped_column(String(300))
    annotated_image_path: Mapped[str] = mapped_column(String(300))
    privacy_regions_blurred: Mapped[int] = mapped_column(Integer, default=0)
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)

    report: Mapped[ParkingReport | None] = relationship(back_populates="detection")


class WeatherObservation(TimestampMixin, Base):
    __tablename__ = "weather_observations"
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(40))  # nws_live | demo
    observed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    temperature_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    wind_kph: Mapped[float | None] = mapped_column(Float, nullable=True)
    condition: Mapped[str] = mapped_column(String(80), default="Unknown")
    alerts: Mapped[list] = mapped_column(JSON, default=list)
    winter_alert_active: Mapped[bool] = mapped_column(Boolean, default=False)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)


class SatelliteObservation(TimestampMixin, Base):
    __tablename__ = "satellite_observations"
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(40))  # goes19_live | simulated | archived_frames
    acquired_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    image_path: Mapped[str] = mapped_column(String(300))
    overlay_path: Mapped[str] = mapped_column(String(300), default="")
    band_detected: Mapped[bool] = mapped_column(Boolean, default=False)
    band_count: Mapped[int] = mapped_column(Integer, default=0)
    motion_dx_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    motion_dy_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    speed_kph: Mapped[float | None] = mapped_column(Float, nullable=True)
    heading_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    moving_toward_buffalo: Mapped[bool] = mapped_column(Boolean, default=False)
    eta_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
    analysis: Mapped[dict] = mapped_column(JSON, default=dict)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)


class HazardReport(TimestampMixin, Base):
    __tablename__ = "hazard_reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    location_name: Mapped[str] = mapped_column(String(120))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    category: Mapped[str] = mapped_column(String(20))
    confidence: Mapped[float] = mapped_column(Float, default=0.6)
    base_confidence: Mapped[float] = mapped_column(Float, default=0.6)  # before crew votes
    classified_by: Mapped[str] = mapped_column(String(40), default="reporter")
    explanation: Mapped[str] = mapped_column(Text, default="")
    image_path: Mapped[str] = mapped_column(String(300), default="")
    confirmations: Mapped[int] = mapped_column(Integer, default=1)
    clear_votes: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | cleared | expired
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)

    votes: Mapped[list["HazardVote"]] = relationship(back_populates="hazard", cascade="all, delete-orphan")

    @validates("category")
    def _v_cat(self, _, v: str) -> str:
        if v not in HAZARD_CATEGORIES:
            raise ValueError(f"category must be one of {HAZARD_CATEGORIES}")
        return v


class HazardVote(TimestampMixin, Base):
    __tablename__ = "hazard_votes"
    __table_args__ = (UniqueConstraint("hazard_id", "user_id", name="uq_vote_per_user"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    hazard_id: Mapped[int] = mapped_column(ForeignKey("hazard_reports.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    vote: Mapped[str] = mapped_column(String(10))  # confirm | clear
    hazard: Mapped[HazardReport] = relationship(back_populates="votes")


class ParkingRecommendation(TimestampMixin, Base):
    __tablename__ = "parking_recommendations"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    destination: Mapped[str] = mapped_column(String(80))
    arrival_time: Mapped[str] = mapped_column(String(10))
    mode: Mapped[str] = mapped_column(String(20))
    best_lot_slug: Mapped[str | None] = mapped_column(String(40), nullable=True)
    backup_lot_slug: Mapped[str | None] = mapped_column(String(40), nullable=True)
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class Notification(TimestampMixin, Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(30))  # leaving | assist | hazard | scan | ice_season | system
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(String(300), default="")
    lot_id: Mapped[int | None] = mapped_column(ForeignKey("parking_lots.id", ondelete="SET NULL"), nullable=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)


class CrewContribution(TimestampMixin, Base):
    __tablename__ = "crew_contributions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    action: Mapped[str] = mapped_column(String(30))  # scan | report | hazard | verify | clear | leaving | assist
    points: Mapped[int] = mapped_column(Integer, default=0)
    ref_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    user: Mapped[User] = relationship(back_populates="contributions")


class SystemState(TimestampMixin, Base):
    """Singleton row holding the operating mode and how it was decided."""
    __tablename__ = "system_state"
    id: Mapped[int] = mapped_column(primary_key=True)
    mode: Mapped[str] = mapped_column(String(20), default="standard")           # standard | watch | ice
    auto_mode: Mapped[str] = mapped_column(String(20), default="standard")      # what the engine decided
    decision_source: Mapped[str] = mapped_column(String(30), default="satellite_engine")
    # satellite_engine | demo_storm_replay | manual_override
    manual_override: Mapped[str | None] = mapped_column(String(20), nullable=True)
    reason: Mapped[str] = mapped_column(String(300), default="No snow bands or winter alerts detected.")
    demo_active: Mapped[bool] = mapped_column(Boolean, default=False)
    eta_minutes: Mapped[float | None] = mapped_column(Float, nullable=True)
