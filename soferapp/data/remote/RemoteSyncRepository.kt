package ro.priscom.sofer.ui.data.remote

import android.util.Log
import ro.priscom.sofer.ui.data.local.AppDatabase
import ro.priscom.sofer.ui.data.local.EmployeeEntity
import ro.priscom.sofer.ui.data.local.OperatorEntity
import ro.priscom.sofer.ui.data.local.PriceListEntity
import ro.priscom.sofer.ui.data.local.PriceListItemEntity
import ro.priscom.sofer.ui.data.local.RouteEntity
import ro.priscom.sofer.ui.data.local.RouteStationEntity
import ro.priscom.sofer.ui.data.local.StationEntity
import ro.priscom.sofer.ui.data.local.VehicleEntity
import java.time.LocalDate

class RemoteSyncRepository {

    suspend fun syncMasterData(db: AppDatabase, loggedIn: Boolean): MasterSyncResult {
        return try {
            // === 1. MASTER DATA EXISTENTE (operators / employees / vehicles) ===

            val operators = BackendApi.service.getOperatorsApp()
            val employees = BackendApi.service.getEmployeesApp()
            val vehicles = BackendApi.service.getVehiclesApp()

            db.operatorDao().insertAll(
                operators.map {
                    OperatorEntity(
                        id = it.id,
                        name = it.name
                    )
                }
            )

            db.employeeDao().insertAll(
                employees.map {
                    EmployeeEntity(
                        id = it.id,
                        name = it.name,
                        role = it.role ?: "",
                        operatorId = it.operator_id ?: 0,
                        password = "" // backend nu trimite parola; o lași goală local
                    )
                }
            )

            db.vehicleDao().insertAll(
                vehicles.map {
                    VehicleEntity(
                        id = it.id,
                        plateNumber = it.plateNumber,
                        operatorId = it.operatorId
                    )
                }
            )


            // === 2. RUTE / STAȚII / ROUTE_STATIONS ===

            val today = LocalDate.now().toString()

            val routesDto = if (loggedIn) {
                BackendApi.service.getRoutesForDriver(date = today)
            } else {
                BackendApi.service.getRoutesApp()
            }

            // toate stațiile
            val stationsDto = BackendApi.service.getStationsApp()

            // toate legăturile rută–stație
            val routeStationsDto = BackendApi.service.getRouteStationsApp(null)

            db.routeDao().insertAll(
                routesDto.map {
                    RouteEntity(
                        id = it.id,
                        name = it.name,
                        orderIndex = it.order_index,
                        visibleForDrivers = it.visible_for_drivers
                    )
                }
            )

            db.stationDao().insertAll(
                stationsDto.map {
                    StationEntity(
                        id = it.id,
                        name = it.name,
                        latitude = it.latitude,
                        longitude = it.longitude
                    )
                }
            )


            db.routeStationDao().insertAll(
                routeStationsDto.map { rs ->
                    RouteStationEntity(
                        id = rs.id,
                        routeId = rs.route_id,
                        stationId = rs.station_id,
                        orderIndex = rs.order_index,
                        geofenceType = rs.geofence_type,
                        geofenceRadius = rs.geofence_radius,
                        geofencePolygon = rs.geofence_polygon?.let { poly ->
                            // salvăm ca JSON simplu "[[lat,lng],[lat,lng]]"
                            poly.joinToString(
                                prefix = "[",
                                postfix = "]"
                            ) { pair ->
                                "[${pair[0]},${pair[1]}]"
                            }
                        }
                    )
                }
            )

            // === 3. LISTE DE PREȚ ȘI ITEM-URI ===

            val priceListsDto = BackendApi.service.getPriceListsApp()

            db.priceListDao().insertAll(
                priceListsDto.map {
                    PriceListEntity(
                        id = it.id,
                        routeId = it.route_id,
                        categoryId = it.category_id,
                        effectiveFrom = it.effective_from
                    )
                }
            )

            val priceListItemsDto = BackendApi.service.getPriceListItemsApp()

            db.priceListItemDao().insertAll(
                priceListItemsDto.map { item ->
                    PriceListItemEntity(
                        id = item.id,
                        price = item.price,
                        currency = item.currency,
                        priceListId = item.price_list_id,
                        fromStationId = item.from_station_id,
                        toStationId = item.to_station_id
                    )
                }
            )

            // === 4. REZULTAT ===

            MasterSyncResult(
                operators = operators.size,
                employees = employees.size,
                vehicles = vehicles.size,
                routes = routesDto.size,
                stations = stationsDto.size,
                routeStations = routeStationsDto.size,
                priceLists = priceListsDto.size,
                priceListItems = priceListItemsDto.size,
                error = null
            )

        } catch (e: Exception) {
            Log.e("RemoteSyncRepository", "Master sync error", e)
            MasterSyncResult(0, 0, 0, 0, 0, 0, 0, 0, error = e.localizedMessage)
        }
    }

    // 👇 NOU: sincronizarea biletelor salvate local în tickets_local
    suspend fun syncTickets(db: AppDatabase): TicketSyncResult {
        return try {
            val ticketDao = db.ticketDao()
            val pending = ticketDao.getPendingTickets()

            if (pending.isEmpty()) {
                return TicketSyncResult(
                    total = 0,
                    synced = 0,
                    failed = 0,
                    error = null
                )
            }

            val payload = pending.map { t ->
                TicketBatchItemRequest(
                    localId = t.id,
                    tripId = t.tripId,
                    tripVehicleId = t.tripVehicleId,
                    fromStationId = t.fromStationId,
                    toStationId = t.toStationId,
                    seatId = t.seatId,
                    priceListId = t.priceListId,
                    discountTypeId = t.discountTypeId,
                    basePrice = t.basePrice,
                    finalPrice = t.finalPrice,
                    currency = t.currency,
                    paymentMethod = t.paymentMethod,
                    createdAt = t.createdAt
                )
            }

            val response = BackendApi.service.sendTicketsBatch(
                TicketsBatchRequest(tickets = payload)
            )

            var synced = 0
            var failed = 0

            if (response.ok) {
                response.results.forEach { item ->
                    val localId = item.localId
                    if (localId == null) {
                        failed++
                        return@forEach
                    }

                    if (item.ok && item.reservationId != null) {
                        // 1 = synced
                        ticketDao.updateSyncStatus(
                            localId = localId,
                            syncStatus = 1,
                            remoteReservationId = item.reservationId
                        )
                        synced++
                    } else {
                        // 2 = failed
                        ticketDao.updateSyncStatus(
                            localId = localId,
                            syncStatus = 2,
                            remoteReservationId = null
                        )
                        failed++
                    }
                }
            } else {
                // tot batch-ul a eșuat
                pending.forEach { t ->
                    ticketDao.updateSyncStatus(
                        localId = t.id,
                        syncStatus = 2,
                        remoteReservationId = null
                    )
                }
                return TicketSyncResult(
                    total = pending.size,
                    synced = 0,
                    failed = pending.size,
                    error = "Batch response not ok"
                )
            }

            TicketSyncResult(
                total = pending.size,
                synced = synced,
                failed = failed,
                error = null
            )
        } catch (e: Exception) {
            Log.e("RemoteSyncRepository", "syncTickets error", e)
            TicketSyncResult(
                total = 0,
                synced = 0,
                failed = 0,
                error = e.message
            )
        }
    }
}

class TicketSyncResult(
    val total: Int,
    val synced: Int,
    val failed: Int,
    val error: String? = null
)

data class MasterSyncResult(
    val operators: Int,
    val employees: Int,
    val vehicles: Int,
    val routes: Int,
    val stations: Int,
    val routeStations: Int,
    val priceLists: Int,
    val priceListItems: Int,
    val error: String? = null
)
