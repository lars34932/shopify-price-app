-- CreateTable
CREATE TABLE "StockXCredential" (
    "id" SERIAL NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresIn" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockXCredential_pkey" PRIMARY KEY ("id")
);
