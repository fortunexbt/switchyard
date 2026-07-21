from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Integer, String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .schemas import AuditReceipt, ReceiptStatus


class Base(DeclarativeBase):
    pass


class ReceiptRow(Base):
    """Receipt metadata only: request and result bodies never enter this table."""

    __tablename__ = "audit_receipts"

    receipt_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(20), index=True)
    action_kind: Mapped[str] = mapped_column(String(40))
    capability: Mapped[str] = mapped_column(String(40))
    policy_code: Mapped[str] = mapped_column(String(80))
    stop_generation: Mapped[int] = mapped_column(Integer)
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    result_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    synthetic: Mapped[bool] = mapped_column(Boolean)


class ReceiptStore:
    def __init__(self, database_url: str) -> None:
        connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
        self._engine = create_engine(database_url, connect_args=connect_args)
        self._session = sessionmaker(bind=self._engine, expire_on_commit=False)

    def initialize(self) -> None:
        Base.metadata.create_all(self._engine)

    def append(self, receipt: AuditReceipt) -> None:
        row = ReceiptRow(**receipt.model_dump())
        with self._session.begin() as session:
            session.add(row)

    def recent(self, limit: int) -> list[AuditReceipt]:
        statement = select(ReceiptRow).order_by(ReceiptRow.created_at.desc()).limit(limit)
        with self._session() as session:
            rows = session.scalars(statement).all()
        return [self._to_schema(row) for row in rows]

    def dispose(self) -> None:
        self._engine.dispose()

    @staticmethod
    def _to_schema(row: ReceiptRow) -> AuditReceipt:
        created_at = row.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        return AuditReceipt(
            receipt_id=row.receipt_id,
            created_at=created_at,
            status=ReceiptStatus(row.status),
            action_kind=row.action_kind,
            capability=row.capability,
            policy_code=row.policy_code,
            stop_generation=row.stop_generation,
            request_fingerprint=row.request_fingerprint,
            result_fingerprint=row.result_fingerprint,
            synthetic=row.synthetic,
        )
